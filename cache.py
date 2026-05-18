"""
cache.py
Birlesik cache katmani.

Ozellikler:
- Opsiyonel Redis (REDIS_URL env varsa kullanir, yoksa in-memory dict).
- Normalize edilmis cache key (TR karakter, lowercase, fazla bosluk, noktalama).
- Negative cache (hata yanitlari icin kisa TTL).
- TTL bazli expiry + boyut siniri (in-memory mode'da).
- Thread-safe.

Client API'sini (HTTP response sekli) DEGISTIRMEZ.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import unicodedata
from typing import Any, Optional

# ============== KONFIG ==============
DEFAULT_TTL = int(os.environ.get("CACHE_TTL", "300"))
NEGATIVE_TTL = int(os.environ.get("CACHE_NEGATIVE_TTL", "30"))
MAX_LOCAL_ENTRIES = int(os.environ.get("CACHE_MAX_LOCAL", "500"))
KEY_PREFIX = os.environ.get("CACHE_PREFIX", "aichat:")

# ============== REDIS (opsiyonel) ==============
_redis = None
_redis_url = os.environ.get("REDIS_URL")
if _redis_url:
    try:
        import redis  # type: ignore

        _redis = redis.Redis.from_url(
            _redis_url,
            socket_timeout=0.5,
            socket_connect_timeout=0.5,
            health_check_interval=30,
            decode_responses=False,
        )
        # Ping testi - basarisizsa lokal moda dus
        _redis.ping()
        print(f"[cache] Redis baglandi: {_redis_url.split('@')[-1]}")
    except Exception as _e:
        print(f"[cache] Redis kullanilamadi, in-memory mode: {_e}")
        _redis = None
else:
    print("[cache] REDIS_URL yok, in-memory mode")

# ============== IN-MEMORY FALLBACK ==============
_local: dict[str, tuple[bytes, float]] = {}
_local_lock = threading.Lock()

import builtins as _builtins
# Single-flight refresh tracking (asagida `set` adli fonksiyonumuz builtin'i golgeledigi
# icin builtins.set'i acikca cagiriyoruz).
_inflight = _builtins.set()
_inflight_lock = threading.Lock()


def _local_get(key: str) -> Optional[bytes]:
    with _local_lock:
        item = _local.get(key)
        if not item:
            return None
        value, expires_at = item
        if time.time() >= expires_at:
            _local.pop(key, None)
            return None
        return value


def _local_set(key: str, value: bytes, ttl: int) -> None:
    with _local_lock:
        if len(_local) >= MAX_LOCAL_ENTRIES:
            # En eski 20%'yi temizle
            cutoff = sorted(_local.items(), key=lambda x: x[1][1])[: MAX_LOCAL_ENTRIES // 5]
            for k, _ in cutoff:
                _local.pop(k, None)
        _local[key] = (value, time.time() + ttl)


def _local_delete(key: str) -> None:
    with _local_lock:
        _local.pop(key, None)


def _local_size() -> int:
    with _local_lock:
        return len(_local)


# ============== NORMALIZE ==============
_PUNCT_RE = re.compile(r"[^\w\s]", flags=re.UNICODE)
_WS_RE = re.compile(r"\s+")
_LETTER_DIGIT_RE = re.compile(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", flags=re.IGNORECASE)
_TR_MAP = str.maketrans({
    "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
    "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c",
})


def normalize_question(q: str) -> str:
    """TR karakterleri sadeleştir, lowercase, fazla boşluk ve noktalama temizle.
    Ayrica harf-rakam sinirina bosluk koyar (bist100 <-> bist 100 ayni hale gelsin)."""
    if not q:
        return ""
    s = q.translate(_TR_MAP).lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = _PUNCT_RE.sub(" ", s)
    s = _LETTER_DIGIT_RE.sub(" ", s)
    s = _WS_RE.sub(" ", s).strip()
    return s


def make_key(question: str, history: list | None = None, extra: str = "") -> str:
    """Normalize edilmis question + son 3 mesaj icerigi -> md5 hash."""
    norm_q = normalize_question(question)
    hist_part = []
    for msg in (history or [])[-3:]:
        role = "u" if msg.get("isUser") else "a"
        text = normalize_question(msg.get("text", ""))[:200]
        hist_part.append(f"{role}:{text}")
    payload = json.dumps({"q": norm_q, "h": hist_part, "x": extra}, sort_keys=True, ensure_ascii=False)
    h = hashlib.md5(payload.encode("utf-8")).hexdigest()
    return f"{KEY_PREFIX}{h}"


def make_negative_key(question: str) -> str:
    return f"{KEY_PREFIX}neg:{hashlib.md5(normalize_question(question).encode('utf-8')).hexdigest()}"


# ============== PUBLIC API ==============
def get(key: str) -> Any:
    """Cache'den degeri al (JSON decode edilmis). Yoksa None."""
    raw: Optional[bytes] = None
    if _redis is not None:
        try:
            raw = _redis.get(key)
        except Exception as e:
            print(f"[cache] redis get hata: {e}")
            raw = None
    if raw is None:
        raw = _local_get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def set(key: str, value: Any, ttl: int = DEFAULT_TTL) -> None:
    """Degeri JSON olarak cache'e yaz."""
    try:
        raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as e:
        print(f"[cache] serialize hata: {e}")
        return
    if _redis is not None:
        try:
            _redis.setex(key, ttl, raw)
            return
        except Exception as e:
            print(f"[cache] redis set hata, lokale dustu: {e}")
    _local_set(key, raw, ttl)


def delete(key: str) -> None:
    if _redis is not None:
        try:
            _redis.delete(key)
        except Exception:
            pass
    _local_delete(key)


def set_negative(question: str, error: str, ttl: int = NEGATIVE_TTL) -> None:
    """Hata yanitini kisa sureli cache'le (thundering herd engelleme)."""
    set(make_negative_key(question), {"error": error, "ts": time.time()}, ttl=ttl)


def get_negative(question: str) -> Optional[dict]:
    return get(make_negative_key(question))


def stats() -> dict:
    backend = "redis" if _redis is not None else "memory"
    size = None
    if _redis is not None:
        try:
            # Yaklaşık sayım - sadece bizim prefix
            size = len(list(_redis.scan_iter(match=f"{KEY_PREFIX}*", count=500)))
        except Exception:
            size = -1
    else:
        size = _local_size()
    return {"backend": backend, "size": size, "default_ttl": DEFAULT_TTL, "negative_ttl": NEGATIVE_TTL}


def clear_all(prefix: Optional[str] = None) -> dict:
    """Cache'i temizle. prefix verilirse sadece o prefix'te olanlari siler.

    Donen dict: {"backend": "...", "deleted": N}
    """
    pattern_prefix = prefix if prefix else KEY_PREFIX
    deleted = 0
    backend = "redis" if _redis is not None else "memory"
    if _redis is not None:
        try:
            keys = list(_redis.scan_iter(match=f"{pattern_prefix}*", count=500))
            if keys:
                deleted = _redis.delete(*keys)
        except Exception as e:
            print(f"[cache] clear_all redis hata: {e}")
    # Lokal cache'i de bosalt (hybrid mode olabilir)
    with _local_lock:
        if prefix:
            to_del = [k for k in _local if k.startswith(pattern_prefix)]
            for k in to_del:
                _local.pop(k, None)
            deleted += len(to_del)
        else:
            deleted += len(_local)
            _local.clear()
    return {"backend": backend, "deleted": int(deleted)}


# ============== STALE-WHILE-REVALIDATE ==============
# Single-flight: ayni key icin paralel refresh tetiklenmesin.
# (_inflight ve _inflight_lock yukarida tanimli.)


def try_acquire_refresh(key: str) -> bool:
    """True donerse refresh'i bu thread yapacak. False = baska thread zaten yapiyor."""
    with _inflight_lock:
        if key in _inflight:
            return False
        _inflight.add(key)
        return True


def release_refresh(key: str) -> None:
    with _inflight_lock:
        _inflight.discard(key)


def swr_set(key: str, value: Any, fresh_ttl: int = DEFAULT_TTL, stale_ttl: int = 3600) -> None:
    """Stale-while-revalidate kaydet.
    fresh_ttl: bu sure icinde 'taze' kabul edilir, dogrudan donulur.
    stale_ttl: bu sureye kadar eski yanit donulebilir + arka planda yenilenir.
    Toplam expiry = fresh_ttl + stale_ttl.
    """
    now = time.time()
    wrapped = {
        "_swr_v": 1,
        "_swr_fresh_until": now + fresh_ttl,
        "_swr_hard_until": now + fresh_ttl + stale_ttl,
        "data": value,
    }
    set(key, wrapped, ttl=fresh_ttl + stale_ttl)


def swr_get(key: str) -> tuple[Optional[Any], bool]:
    """(value, is_stale) doner. value None ise miss.
    is_stale True ise caller arka planda refresh tetiklemeli."""
    raw = get(key)
    if raw is None:
        return None, False
    # Geriye uyumluluk: eski format (sadece value)
    if not (isinstance(raw, dict) and raw.get("_swr_v") == 1):
        return raw, False
    now = time.time()
    if now >= raw.get("_swr_hard_until", 0):
        return None, False
    is_stale = now >= raw.get("_swr_fresh_until", 0)
    return raw.get("data"), is_stale
