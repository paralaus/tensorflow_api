"""Lokal embedding modeli (sentence-transformers).

Model: paraphrase-multilingual-MiniLM-L12-v2 (~120MB, Turkce destekli, CPU'da 20-40ms)
Alternatif env ile: RAG_EMBED_MODEL="BAAI/bge-m3" (daha kaliteli, ~500MB)

Tasarim notlari:
- Lazy load: ilk kullanimda model belege yuklenir; import sirasinda yuklenmez (server boot'u
  yavaslamasin).
- Thread-safe: Lock ile tek seferlik init.
- Batch encode destegi (ingest icin).
- Bagimliliklar yoksa _DISABLED=True - cagrilar None / [] doner.

Cikti:
    embed_query(text) -> list[float] (boyut: model.dim)
    embed_batch(texts) -> list[list[float]]
"""
from __future__ import annotations

import os
import threading
import logging
from typing import Optional

MODEL_NAME = os.environ.get("RAG_EMBED_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")
NORMALIZE = os.environ.get("RAG_EMBED_NORMALIZE", "1") == "1"  # cosine icin normalize
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()

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
        try:
            # CPU'da calistir - GPU yoksa otomatik dusurur ama daha hizli init icin acik:
            os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
            # HF Hub warning log flood'unu azalt (token varsa zaten auth'li gider).
            logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
            from sentence_transformers import SentenceTransformer  # type: ignore

            print(f"[rag/embedder] Model yukleniyor: {MODEL_NAME} ...")
            st_kwargs = {"device": "cpu"}
            if HF_TOKEN:
                st_kwargs["token"] = HF_TOKEN
            _model = SentenceTransformer(MODEL_NAME, **st_kwargs)
            # Backward compatibility across sentence-transformers versions.
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
    if is_ready():
        try:
            _model.encode("isinma", show_progress_bar=False)
        except Exception:
            pass
