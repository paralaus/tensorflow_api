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

# Provider secimi. Varsayilan sira: OpenAI -> DigitalOcean -> local.
#
# OpenAI one alindi cunku DigitalOcean embeddings ucu hesap seviyesinde
# 402 ("Payment Required / You are not allowed to perform this operation")
# donuyordu ve bu RAG'i SESSIZCE olduruyordu: embed_query None doner,
# retrieve() None doner, /psychology/chat literaturu hic eklemeden devam
# eder. Teshis icin scripts/rag_psych_doctor.py.
_DO_KEY = (os.environ.get("DIGITALOCEAN_API_KEY") or os.environ.get("DO_API_KEY") or "").strip()
_OPENAI_KEY = (os.environ.get("OPENAI_API_KEY") or "").strip()
if _OPENAI_KEY:
    _DEFAULT_PROVIDER = "openai"
elif _DO_KEY:
    _DEFAULT_PROVIDER = "digitalocean"
else:
    _DEFAULT_PROVIDER = "local"
PROVIDER = os.environ.get("RAG_EMBED_PROVIDER", _DEFAULT_PROVIDER).strip().lower()

# Uzak saglayicilar ayni kod yolunu paylasiyor (acilis probu, circuit
# breaker, batch chunk'lama); yalnizca endpoint/anahtar/model farkli.
_IS_REMOTE = PROVIDER in ("openai", "digitalocean")

# Model adlari (provider'a gore default farkli)
if PROVIDER == "openai":
    MODEL_NAME = os.environ.get("RAG_EMBED_MODEL", "text-embedding-3-small")
elif PROVIDER == "digitalocean":
    MODEL_NAME = os.environ.get("RAG_EMBED_MODEL", "qwen3-embedding-0-6b")
else:
    MODEL_NAME = os.environ.get("RAG_EMBED_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")

# SESSIZ UYUMSUZLUK KORUMASI: RAG_EMBED_PROVIDER ile RAG_EMBED_MODEL ayri
# env degiskenleri, biri degistirilip digeri unutuluyor. Sonucu her istekte
# 400 ve bos RAG - yani gorunurde hicbir sey. Acilista bir kez bagiriyoruz.
if PROVIDER == "openai" and not MODEL_NAME.startswith("text-embedding-"):
    print(
        f"[rag/embedder] UYARI: saglayici 'openai' ama RAG_EMBED_MODEL "
        f"'{MODEL_NAME}' - OpenAI embedding modeli degil. "
        f"RAG_EMBED_MODEL=text-embedding-3-small olmali."
    )

NORMALIZE = os.environ.get("RAG_EMBED_NORMALIZE", "1") == "1"  # cosine icin normalize
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()

# DigitalOcean Serverless Inference endpoint (OpenAI-uyumlu)
DO_BASE_URL = os.environ.get("DIGITALOCEAN_BASE_URL", "https://inference.do-ai.run/v1").rstrip("/")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
# DO inference zaman zaman cok yavas; dis RAG_QUERY_TIMEOUT (default 3s) ile
# uyumlu olmasi icin query timeout'u kisa, ingest icin ayri (uzun) tutuyoruz.
DO_QUERY_TIMEOUT = float(os.environ.get("RAG_EMBED_QUERY_TIMEOUT", "2.5"))
DO_INGEST_TIMEOUT = float(os.environ.get("RAG_EMBED_TIMEOUT", "30"))
DO_CONNECT_TIMEOUT = float(os.environ.get("RAG_EMBED_CONNECT_TIMEOUT", "1.5"))
DO_BATCH_LIMIT = int(os.environ.get("RAG_EMBED_BATCH", "64"))

# Ardisik hatalardan sonra kisa devre kes (her istekte yine timeout yememek icin)
_FAIL_THRESHOLD = int(os.environ.get("RAG_EMBED_FAIL_THRESHOLD", "3"))
_COOLDOWN_SEC = float(os.environ.get("RAG_EMBED_COOLDOWN_SEC", "30"))
_fail_count = 0
_cooldown_until = 0.0

# Remote saglayicinin ILK acilis probu basarisiz olursa ne kadar sonra
# tekrar denenecegi (bkz. _ensure_loaded icindeki not).
_INIT_RETRY_SEC = float(os.environ.get("RAG_EMBED_INIT_RETRY_SEC", "120"))
_init_retry_after = 0.0

# INGEST icin tekrar deneme. embed_query'den AYRI tutuluyor: sohbet yolunda
# uzun beklemek kabul edilemez (orada devrede olan sey circuit breaker),
# ama ingest toplu ve arka planda calisiyor, orada beklemek dogru davranis.
#
# NEDEN GEREKLI: OpenAI'in dakika basina token limiti (TPM) toplu ingest'te
# kolayca doluyor. 429 geldiginde eski kod butun batch'i dusurup bos liste
# donduruyor, ingest de o batch'i "atlandi" deyip geciyordu. Sonuc SESSIZ
# EKSIK INDEKS: sahada 12282 chunk'in yalnizca 8128'i yazildi, 4154 chunk
# hicbir yerde gorunmeden kayboldu. TPM limiti bir dakika icinde sifirlandigi
# icin beklemek tek dogru cevap.
_BATCH_RETRIES = int(os.environ.get("RAG_EMBED_BATCH_RETRIES", "6"))
_BATCH_RETRY_BASE_SEC = float(os.environ.get("RAG_EMBED_RETRY_BASE_SEC", "10"))
# Batch'ler arasi bekleme; TPM'e surekli carpiyorsan 0.5-1 sn ver.
_BATCH_PAUSE_SEC = float(os.environ.get("RAG_EMBED_BATCH_PAUSE_SEC", "0"))


def _is_retryable(message: str) -> bool:
    """429 (kota/hiz) ve 5xx gecici; 400/401 kalici."""
    m = (message or "").lower()
    if "429" in m or "rate limit" in m or "too many requests" in m:
        return True
    return any(code in m for code in (" 500", " 502", " 503", " 504", "-> 500", "-> 502", "-> 503", "-> 504"))


def _remote_embed_batch_retrying(texts: list[str]) -> list[list[float]]:
    """Tek bir batch'i, gecici hatalarda bekleyerek tekrar dener."""
    import time as _time
    last = ""
    for attempt in range(1, _BATCH_RETRIES + 1):
        try:
            return _remote_embed_request(texts)
        except Exception as e:
            last = str(e)
            if not _is_retryable(last) or attempt == _BATCH_RETRIES:
                raise
            wait = _BATCH_RETRY_BASE_SEC * attempt
            print(f"[rag/embedder] batch gecici hata (deneme {attempt}/{_BATCH_RETRIES}), "
                  f"{wait:.0f}s bekleniyor: {last[:120]}")
            _time.sleep(wait)
    raise RuntimeError(last)

_model = None
_dim: Optional[int] = None
_lock = threading.Lock()
_DISABLED = False
_LOAD_ATTEMPTED = False


def _ensure_loaded():
    global _model, _dim, _DISABLED, _LOAD_ATTEMPTED, _init_retry_after
    if _model is not None or _DISABLED:
        return
    with _lock:
        if _model is not None or _DISABLED:
            return
        _LOAD_ATTEMPTED = True

        if _IS_REMOTE:
            _key = _OPENAI_KEY if PROVIDER == "openai" else _DO_KEY
            if not _key:
                _var = "OPENAI_API_KEY" if PROVIDER == "openai" else "DIGITALOCEAN_API_KEY"
                print(f"[rag/embedder] {_var} yok, remote embedding devre disi.")
                _DISABLED = True  # anahtar yoksa beklemenin anlami yok, bu gercekten kalici
                return
            import time as _time
            if _init_retry_after and _time.time() < _init_retry_after:
                return
            try:
                # Boyut algilamak icin tek seferlik prob istegi.
                vec = _remote_embed_request(["init"])
                if not vec or not vec[0]:
                    raise RuntimeError("empty response")
                _dim = len(vec[0])
                _model = PROVIDER  # sentinel; lookup'larda is_ready() icin
                _init_retry_after = 0.0
                print(f"[rag/embedder] {PROVIDER} remote OK (model={MODEL_NAME}, dim={_dim})")
            except Exception as e:
                # KALICI OLARAK KAPATMIYORUZ. Eskiden burada _DISABLED = True
                # vardi ve bedeli agirdi: acilis aninda saglayici bir saniye
                # bile cevap vermezse (kota, 402, gecici ag hatasi) RAG O
                # SUREC BOYUNCA olu kaliyordu. Saglayici bes dakika sonra
                # duzelse bile kendiliginden toparlanmiyor, birinin
                # `systemctl restart tensorflow-api` demesi gerekiyordu - ve
                # hicbir katman hata uretmedigi icin kimse fark etmiyordu.
                # Artik bir sure bekleyip tekrar deniyoruz.
                _init_retry_after = _time.time() + _INIT_RETRY_SEC
                print(
                    f"[rag/embedder] {PROVIDER} init hata: {e} "
                    f"({_INIT_RETRY_SEC:.0f}s sonra tekrar denenecek)"
                )
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


def _do_embed_request(texts: list[str], timeout: Optional[float] = None) -> list[list[float]]:
    """DigitalOcean OpenAI-uyumlu /v1/embeddings cagrisi. Hata -> exception."""
    if not texts:
        return []
    payload = {"model": MODEL_NAME, "input": texts}
    headers = {
        "Authorization": f"Bearer {_DO_KEY}",
        "Content-Type": "application/json",
    }
    read_to = timeout if timeout is not None else DO_INGEST_TIMEOUT
    resp = requests.post(
        f"{DO_BASE_URL}/embeddings",
        headers=headers,
        json=payload,
        timeout=(DO_CONNECT_TIMEOUT, read_to),
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


def _openai_embed_request(texts: list[str], timeout: Optional[float] = None) -> list[list[float]]:
    """OpenAI /v1/embeddings cagrisi. Hata -> exception."""
    if not texts:
        return []
    read_to = timeout if timeout is not None else DO_INGEST_TIMEOUT
    resp = requests.post(
        f"{OPENAI_BASE_URL}/embeddings",
        headers={
            "Authorization": f"Bearer {_OPENAI_KEY}",
            "Content-Type": "application/json",
        },
        json={"model": MODEL_NAME, "input": texts},
        timeout=(DO_CONNECT_TIMEOUT, read_to),
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"OpenAI embeddings -> {resp.status_code} {resp.text[:200]}")
    data = resp.json() or {}
    items = data.get("data") or []
    # OpenAI dizinin sirasini garanti etmiyor, 'index' alanina gore siraliyoruz -
    # sira kayarsa chunk'lar YANLIS vektorle eslesir ve bu hicbir hata
    # uretmeden arama kalitesini bozar.
    try:
        items = sorted(items, key=lambda it: it.get("index", 0))
    except Exception:
        pass
    out: list[list[float]] = []
    for item in items:
        emb = item.get("embedding") if isinstance(item, dict) else None
        if not isinstance(emb, list):
            raise RuntimeError("OpenAI embeddings: malformed response")
        if NORMALIZE:
            emb = _l2_normalize(emb)
        out.append(emb)
    if len(out) != len(texts):
        raise RuntimeError(f"OpenAI embeddings: expected {len(texts)} got {len(out)}")
    return out


def _remote_embed_request(texts: list[str], timeout: Optional[float] = None) -> list[list[float]]:
    """Secili uzak saglayiciya yonlendirir."""
    if PROVIDER == "openai":
        return _openai_embed_request(texts, timeout=timeout)
    return _do_embed_request(texts, timeout=timeout)


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
    global _fail_count, _cooldown_until
    if not text or not text.strip():
        return None
    _ensure_loaded()
    if _DISABLED or _model is None:
        return None
    # Circuit breaker: ardisik timeout sonrasi kisa sure atla
    if _IS_REMOTE:
        import time as _time
        if _cooldown_until and _time.time() < _cooldown_until:
            return None
    try:
        if _IS_REMOTE:
            out = _remote_embed_request([text], timeout=DO_QUERY_TIMEOUT)
            _fail_count = 0
            _cooldown_until = 0.0
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
        if _IS_REMOTE:
            import time as _time
            _fail_count += 1
            if _fail_count >= _FAIL_THRESHOLD:
                _cooldown_until = _time.time() + _COOLDOWN_SEC
                print(
                    f"[rag/embedder] {_fail_count} ardisik hata, "
                    f"{_COOLDOWN_SEC:.0f}s cooldown."
                )
                _fail_count = 0
        return None


def embed_batch(texts: list[str], batch_size: int = 32) -> list[list[float]]:
    """Toplu embedding (ingest icin). Bos/disabled -> []."""
    if not texts:
        return []
    _ensure_loaded()
    if _DISABLED or _model is None:
        return []
    try:
        if _IS_REMOTE:
            # Uzak API'yi batch_size'a gore chunkla (default 64)
            import time as _time
            out: list[list[float]] = []
            step = min(batch_size, DO_BATCH_LIMIT)
            for i in range(0, len(texts), step):
                chunk = texts[i:i + step]
                out.extend(_remote_embed_batch_retrying(chunk))
                if _BATCH_PAUSE_SEC > 0 and i + step < len(texts):
                    _time.sleep(_BATCH_PAUSE_SEC)
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
        if _IS_REMOTE:
            _remote_embed_request(["isinma"])
        else:
            _model.encode("isinma", show_progress_bar=False)
    except Exception:
        pass
