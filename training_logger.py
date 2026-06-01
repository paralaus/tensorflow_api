"""
Fine-tuning veri toplama: basarili /chat yanitlarini Mongo'ya yazar.

Cron (`scripts/run_finetune_cron.sh`) bu koleksiyondan okuyup JSONL'e export
ediyor. Buraya yazma yoksa total_rows=0 kalir.

Tasarim notlari:
- Fire-and-forget: kullanici istek path'inde latency yaratmaz, hatalar yutulur.
- Lazy & thread-safe Mongo client.
- MONGODB_URI (cron ile ayni: poker DB) -> fallback MONGODB_URL.
- TRAINING_LOG_ENABLED=false ile tamamen kapatilabilir.
- Sadece "temiz" ornekler: cache hit / hata / bos cevap yazilmaz.
"""

from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

try:
    from pymongo import MongoClient  # type: ignore
    _HAS_PYMONGO = True
except Exception as _e:  # pragma: no cover
    MongoClient = None  # type: ignore
    _HAS_PYMONGO = False
    print(f"[training_logger] pymongo yok, devre disi: {_e}")


_ENABLED = os.environ.get("TRAINING_LOG_ENABLED", "true").lower() in ("1", "true", "yes", "on")
_DB_NAME = os.environ.get("TRAINING_LOG_DB", "poker")
_COLLECTION_NAME = os.environ.get("TRAINING_LOG_COLLECTION", "ai_training_logs")
_MAX_Q = int(os.environ.get("TRAINING_LOG_MAX_QUESTION", "4000"))
_MAX_A = int(os.environ.get("TRAINING_LOG_MAX_ANSWER", "8000"))
_MIN_A = int(os.environ.get("TRAINING_LOG_MIN_ANSWER", "8"))

_client = None
_collection = None
_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="train-log")
_disabled_reason: str | None = None


def _resolve_uri() -> str | None:
    return (
        os.environ.get("TRAINING_LOG_MONGODB_URI")
        or os.environ.get("MONGODB_URI")
        or os.environ.get("MONGODB_URL")
        or os.environ.get("MONGO_URL")
    )


def _get_collection():
    global _client, _collection, _disabled_reason
    if not _ENABLED or not _HAS_PYMONGO:
        return None
    if _collection is not None:
        return _collection
    uri = _resolve_uri()
    if not uri:
        if _disabled_reason is None:
            _disabled_reason = "no_uri"
            print("[training_logger] MONGODB_URI yok, devre disi.")
        return None
    with _lock:
        if _collection is not None:
            return _collection
        try:
            _client = MongoClient(
                uri,
                serverSelectionTimeoutMS=2000,
                connectTimeoutMS=2000,
                socketTimeoutMS=3000,
                appname="hissechat-training-logger",
            )
            db = _client[_DB_NAME]
            _collection = db[_COLLECTION_NAME]
            print(
                f"[training_logger] aktif: db={_DB_NAME} collection={_COLLECTION_NAME}"
            )
        except Exception as e:
            _disabled_reason = f"connect_error:{e}"
            print(f"[training_logger] Mongo baglanti hatasi: {e}")
            return None
    return _collection


def _clean(value: Any, limit: int) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if len(text) > limit:
        text = text[:limit]
    return text


def _serialize_context(context: Any) -> Any:
    if not context:
        return None
    if isinstance(context, (str, int, float, bool)):
        return context
    try:
        import json as _json
        s = _json.dumps(context, ensure_ascii=False, default=str)
        if len(s) > 4000:
            s = s[:4000]
        return s
    except Exception:
        return None


def _write(doc: dict) -> None:
    coll = _get_collection()
    if coll is None:
        return
    try:
        coll.insert_one(doc)
    except Exception as e:
        # Hata client'a sizmamali, sadece log
        print(f"[training_logger] insert hata: {e}")


def log_sample(
    *,
    question: str | None,
    answer: str | None,
    context: Any = None,
    model: str | None = None,
    provider: str | None = None,
    tokens: Any = None,
    detail_level: str | None = None,
    live: bool = False,
    cached: bool = False,
    source: str = "chat",
    extra: dict | None = None,
) -> None:
    """Fire-and-forget kayit. Hata firlatmaz."""
    if not _ENABLED:
        return
    if cached:
        return  # Cache hit'leri tekrar yazma, duplicate olur
    q = _clean(question, _MAX_Q)
    a = _clean(answer, _MAX_A)
    if not q or len(a) < _MIN_A:
        return
    doc: dict[str, Any] = {
        "question": q,
        "answer": a,
        "createdAt": datetime.now(timezone.utc),
        "source": source,
    }
    ctx = _serialize_context(context)
    if ctx is not None:
        doc["context"] = ctx
    if model:
        doc["model"] = str(model)
    if provider:
        doc["provider"] = str(provider)
    if tokens is not None:
        doc["tokens"] = tokens
    if detail_level:
        doc["detailLevel"] = str(detail_level)
    if live:
        doc["live"] = True
    if extra:
        try:
            doc["extra"] = extra
        except Exception:
            pass
    try:
        _executor.submit(_write, doc)
    except Exception as e:
        print(f"[training_logger] submit hata: {e}")


def status() -> dict:
    return {
        "enabled": _ENABLED,
        "has_pymongo": _HAS_PYMONGO,
        "db": _DB_NAME,
        "collection": _COLLECTION_NAME,
        "connected": _collection is not None,
        "disabled_reason": _disabled_reason,
    }
