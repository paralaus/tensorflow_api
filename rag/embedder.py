"""Embedding modeli - DigitalOcean (remote) veya sentence-transformers (lokal).

Saglayicilar:
- "digitalocean" (default, eger DIGITALOCEAN_API_KEY varsa): Qwen3 Embedding 0.6B
  via https://inference.do-ai.run/v1/embeddings  (tek key ile butun modeller)
  -> Turkce + finans icin lokal MiniLM'den belirgin sekilde daha kaliteli.
- "local": sentence-transformers (paraphrase-multilingual-MiniLM-L12-v2 vb.)

Secim:
    RAG_EMBED_PROVIDER = "digitalocean" | "local"  (default: key varsa digitalocean)
    RAG_EMBED_MODEL    = DO icin "qwen3-embedding-0-6b"; local icin HF model adi

Cikti:
    embed_query(text) -> list[float]
    embed_batch(texts) -> list[list[float]]
Hata/disabled durumunda None / [] doner.
"""
from __future__ import annotations

import os
import threading
import logging
from typing import Optional

import requests

# Provider secimi
_DO_KEY = (os.environ.get("DIGITALOCEAN_API_KEY") or os.environ.get("DO_API_KEY") or "").strip()
_DEFAULT_PROVIDER = "digitalocean" if _DO_KEY else "local"
PROVIDER = os.environ.get("RAG_EMBED_PROVIDER", _DEFAULT_PROVIDER).strip().lower()

# Model adlari (provider'a gore default farkli)
if PROVIDER == "digitalocean":
    MODEL_NAME = os.environ.get("RAG_EMBED_MODEL", "qwen3-embedding-0-6b")
else:
    MODEL_NAME = os.environ.get("RAG_EMBED_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")

NORMALIZE = os.environ.get("RAG_EMBED_NORMALIZE", "1") == "1"  # cosine icin normalize
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()

# DigitalOcean Serverless Inference endpoint (OpenAI-uyumlu)
DO_BASE_URL = os.environ.get("DIGITALOCEAN_BASE_URL", "https://inference.do-ai.run/v1").rstrip("/")
DO_TIMEOUT = float(os.environ.get("RAG_EMBED_TIMEOUT", "30"))
DO_BATCH_LIMIT = int(os.environ.get("RAG_EMBED_BATCH", "64"))

_model = None
_dim: Optional[int] = None
_lock = threading.Lock()
_DISABLED = False
_LOAD_ATTEMPTED = False


def _ensure_loaded():
    global _model, _dim, _DISABLED, _LOAD_ATTEMPTED
    if _model is not None or _DISABLED:
        return
    with _lock:
        if _model is not None or _DISABLED:
            return
        _LOAD_ATTEMPTED = True

        if PROVIDER == "digitalocean":
            if not _DO_KEY:
                print("[rag/embedder] DIGITALOCEAN_API_KEY yok, remote embedding devre disi.")
                _DISABLED = True
                return
            try:
                # Boyut algilamak icin tek seferlik prob istegi.
                vec = _do_embed_request(["init"])
                if not vec or not vec[0]:
                    raise RuntimeError("empty response")
                _dim = len(vec[0])
                _model = "digitalocean"  # sentinel; lookup'larda is_ready() icin
                print(f"[rag/embedder] DigitalOcean remote OK (model={MODEL_NAME}, dim={_dim})")
            except Exception as e:
                print(f"[rag/embedder] DigitalOcean init hata: {e}")
                _DISABLED = True
            return

        # PROVIDER == "local"
        try:
            os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
            logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
            from sentence_transformers import SentenceTransformer  # type: ignore

            print(f"[rag/embedder] Model yukleniyor: {MODEL_NAME} ...")
            st_kwargs = {"device": "cpu"}
            if HF_TOKEN:
                st_kwargs["token"] = HF_TOKEN
            _model = SentenceTransformer(MODEL_NAME, **st_kwargs)
            if hasattr(_model, "get_embedding_dimension"):
                _dim = _model.get_embedding_dimension()
            else:
                _dim = _model.get_sentence_embedding_dimension()
            print(f"[rag/embedder] OK (dim={_dim})")
        except ImportError:
            print("[rag/embedder] sentence-transformers yuklu degil, RAG embedding devre disi.")
            _DISABLED = True
        except Exception as e:
            print(f"[rag/embedder] Model yuklenemedi: {e}")
            _DISABLED = True


def _do_embed_request(texts: list[str]) -> list[list[float]]:
    """DigitalOcean OpenAI-uyumlu /v1/embeddings cagrisi. Hata -> exception."""
    if not texts:
        return []
    payload = {"model": MODEL_NAME, "input": texts}
    headers = {
        "Authorization": f"Bearer {_DO_KEY}",
        "Content-Type": "application/json",
    }
    resp = requests.post(
        f"{DO_BASE_URL}/embeddings",
        headers=headers,
        json=payload,
        timeout=DO_TIMEOUT,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"DO embeddings -> {resp.status_code} {resp.text[:200]}")
    data = resp.json() or {}
    items = data.get("data") or []
    out: list[list[float]] = []
    for item in items:
        emb = item.get("embedding") if isinstance(item, dict) else None
        if not isinstance(emb, list):
            raise RuntimeError("DO embeddings: malformed response")
        if NORMALIZE:
            emb = _l2_normalize(emb)
        out.append(emb)
    if len(out) != len(texts):
        raise RuntimeError(f"DO embeddings: expected {len(texts)} got {len(out)}")
    return out


def _l2_normalize(vec: list[float]) -> list[float]:
    s = 0.0
    for v in vec:
        s += v * v
    if s <= 0.0:
        return vec
    inv = s ** -0.5
    return [v * inv for v in vec]


def is_ready() -> bool:
    """Server boot kontrolu icin (model yuklu mu?)."""
    return _model is not None and not _DISABLED


def dimension() -> Optional[int]:
    _ensure_loaded()
    return _dim


def embed_query(text: str) -> Optional[list[float]]:
    """Tek sorgu icin embedding. Hata/disabled -> None."""
    if not text or not text.strip():
        return None
    _ensure_loaded()
    if _DISABLED or _model is None:
        return None
    try:
        if PROVIDER == "digitalocean":
            out = _do_embed_request([text])
            return out[0] if out else None
        vec = _model.encode(
            text,
            normalize_embeddings=NORMALIZE,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return vec.tolist()
    except Exception as e:
        print(f"[rag/embedder] embed_query hata: {e}")
        return None


def embed_batch(texts: list[str], batch_size: int = 32) -> list[list[float]]:
    """Toplu embedding (ingest icin). Bos/disabled -> []."""
    if not texts:
        return []
    _ensure_loaded()
    if _DISABLED or _model is None:
        return []
    try:
        if PROVIDER == "digitalocean":
            # DO API'sini batch_size'a gore chunkla (default 64)
            out: list[list[float]] = []
            step = min(batch_size, DO_BATCH_LIMIT)
            for i in range(0, len(texts), step):
                chunk = texts[i:i + step]
                out.extend(_do_embed_request(chunk))
            return out
        vecs = _model.encode(
            texts,
            batch_size=batch_size,
            normalize_embeddings=NORMALIZE,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return [v.tolist() for v in vecs]
    except Exception as e:
        print(f"[rag/embedder] embed_batch hata: {e}")
        return []


def warmup():
    """Server boot sonrasi opsiyonel cagri - ilk istek latency'sini dusurur."""
    _ensure_loaded()
    if not is_ready():
        return
    try:
        if PROVIDER == "digitalocean":
            _do_embed_request(["isinma"])
        else:
            _model.encode("isinma", show_progress_bar=False)
    except Exception:
        pass
