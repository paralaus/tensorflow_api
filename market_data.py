"""
market_data.py
Canlı piyasa verisi çekme modülü (BIST, kripto, döviz).
Sadece Python stdlib kullanır (yeni dependency yok).

Kaynaklar (hepsi ücretsiz ve API-key'siz):
  - Kripto: CoinGecko  -> https://api.coingecko.com
  - Döviz:  open.er-api -> https://open.er-api.com
  - Hisse:  Yahoo Finance chart endpoint (public)

Bu modülün amacı: kullanıcının sorusunu analiz etmek, ilgili
gerçek piyasa verisini (fiyat, değişim) çekmek ve LLM'e "context"
olarak enjekte edilecek kısa bir metin hazırlamaktır.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

# --- HTTP session (keep-alive). requests yoksa urllib fallback ---
try:
    import requests  # type: ignore
    from requests.adapters import HTTPAdapter  # type: ignore

    _session = requests.Session()
    _session.headers.update({
        "User-Agent": "Mozilla/5.0 (HisseChat AI/1.0)",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Connection": "keep-alive",
    })
    _adapter = HTTPAdapter(pool_connections=20, pool_maxsize=50, max_retries=0)
    _session.mount("https://", _adapter)
    _session.mount("http://", _adapter)
    _HAS_REQUESTS = True
except Exception as _e:
    _session = None
    _HAS_REQUESTS = False
    print(f"[market_data] requests yok, urllib fallback: {_e}")

# Paralel fetch icin shared executor (4 worker yeterli: bist+crypto+fx+index)
_md_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="md")

# ---------- Basit, thread-safe TTL cache ----------
_cache: dict[str, tuple[Any, float]] = {}
_cache_lock = threading.Lock()


def _cache_get(key: str, ttl: int):
    with _cache_lock:
        if key in _cache:
            value, ts = _cache[key]
            if time.time() - ts < ttl:
                return value
            _cache.pop(key, None)
    return None


def _cache_set(key: str, value: Any):
    with _cache_lock:
        # Boyut sınırı
        if len(_cache) > 200:
            oldest = sorted(_cache.items(), key=lambda x: x[1][1])[:50]
            for k, _ in oldest:
                _cache.pop(k, None)
        _cache[key] = (value, time.time())


def _http_get_json(url: str, timeout: float = 4.0) -> Any:
    """Kısa timeout'lu GET; başarısızsa None döner. requests.Session keep-alive + gzip."""
    # Once requests.Session (keep-alive, gzip)
    if _HAS_REQUESTS and _session is not None:
        try:
            r = _session.get(url, timeout=timeout)
            if r.status_code != 200:
                return None
            return r.json()
        except Exception as e:
            print(f"[market_data] requests hata ({url}): {e}")
            return None
    # Fallback: urllib
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (HisseChat AI/1.0)",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8", errors="ignore"))
    except Exception as e:
        print(f"[market_data] HTTP hata ({url}): {e}")
        return None


# ============== SEMBOL SÖZLÜKLERİ ==============

# BIST hisseleri (en çok konuşulanlar)
BIST_TICKERS = {
    "THYAO", "SISE", "GARAN", "AKBNK", "ASELS", "KCHOL", "BIMAS", "TUPRS",
    "EREGL", "FROTO", "SAHOL", "TCELL", "KRDMD", "PGSUS", "HALKB", "ISCTR",
    "VAKBN", "YKBNK", "ARCLK", "TOASO", "PETKM", "TTKOM", "MGROS", "HEKTS",
    "ENKAI", "DOHOL", "SASA", "KOZAL", "KOZAA", "IPEKE", "ALARK", "ODAS",
    "CIMSA", "EKGYO", "TAVHL", "ULKER", "VESTL", "SOKM", "BIST100",
}
BIST_INDEX_ALIASES = {
    "bist 100": "XU100", "bist100": "XU100", "bist": "XU100",
    "xu100": "XU100", "endeks": "XU100", "borsa i̇stanbul": "XU100",
    "bist 30": "XU030", "bist30": "XU030", "xu030": "XU030",
}

# Kripto (CoinGecko id -> okunabilir sembol)
CRYPTO_MAP = {
    "btc": "bitcoin", "bitcoin": "bitcoin",
    "eth": "ethereum", "ethereum": "ethereum",
    "bnb": "binancecoin", "binance": "binancecoin",
    "sol": "solana", "solana": "solana",
    "xrp": "ripple", "ripple": "ripple",
    "ada": "cardano", "cardano": "cardano",
    "doge": "dogecoin", "dogecoin": "dogecoin",
    "avax": "avalanche-2", "avalanche": "avalanche-2",
    "trx": "tron", "tron": "tron",
    "link": "chainlink", "chainlink": "chainlink",
    "dot": "polkadot", "polkadot": "polkadot",
    "matic": "matic-network", "polygon": "matic-network",
    "shib": "shiba-inu", "shiba": "shiba-inu",
    "ltc": "litecoin", "litecoin": "litecoin",
    "atom": "cosmos", "cosmos": "cosmos",
    "ton": "the-open-network",
    "pepe": "pepe",
}

# Döviz kodları (kullanıcı sorusundan TRY karşılığı çekilecek)
FX_CODES = {"usd", "eur", "gbp", "chf", "jpy", "cad", "aud", "rub", "cny", "sar", "aed"}


# ============== ENTITY TESPİTİ ==============

def _norm(s: str) -> str:
    return s.lower().replace("i̇", "i").strip()


def detect_entities(question: str) -> dict:
    """Soru metninden BIST/kripto/döviz varlıkları tespit et."""
    q = _norm(question)
    found = {"bist": set(), "crypto": set(), "fx": set(), "index": set()}

    # BIST endeksleri
    for alias, code in BIST_INDEX_ALIASES.items():
        if alias in q:
            found["index"].add(code)

    # BIST hisse senetleri (4-5 harfli ticker upper-case)
    # Hem "THYAO" hem "thyao" yakala
    for ticker in BIST_TICKERS:
        if re.search(rf"\b{ticker.lower()}\b", q):
            found["bist"].add(ticker)

    # Kripto
    for key, coin_id in CRYPTO_MAP.items():
        if re.search(rf"\b{re.escape(key)}\b", q):
            found["crypto"].add(coin_id)

    # Döviz (tl karşılığı)
    if any(w in q for w in ["dolar", "usd"]):
        found["fx"].add("USD")
    if any(w in q for w in ["euro", "eur"]):
        found["fx"].add("EUR")
    if any(w in q for w in ["sterlin", "gbp", "pound"]):
        found["fx"].add("GBP")
    if any(w in q for w in ["frank", "chf", "isvic"]):
        found["fx"].add("CHF")
    if re.search(r"\b(jpy|yen)\b", q):
        found["fx"].add("JPY")

    # Genel "döviz/kur" sorusu
    if any(w in q for w in ["doviz", "döviz", "kur", "kurlar"]) and not found["fx"]:
        found["fx"].update({"USD", "EUR"})

    # Genel "kripto" sorusu
    if any(w in q for w in ["kripto", "coin", "altcoin"]) and not found["crypto"]:
        found["crypto"].update({"bitcoin", "ethereum"})

    return {k: sorted(v) for k, v in found.items()}


# ============== VERİ ÇEKME ==============

def fetch_crypto(coin_ids: list[str]) -> list[dict]:
    """CoinGecko'dan USD fiyat + 24h değişim."""
    if not coin_ids:
        return []
    key = "crypto:" + ",".join(sorted(coin_ids))
    cached = _cache_get(key, ttl=60)
    if cached is not None:
        return cached

    ids_param = urllib.parse.quote(",".join(coin_ids))
    url = (
        f"https://api.coingecko.com/api/v3/simple/price"
        f"?ids={ids_param}&vs_currencies=usd,try&include_24hr_change=true"
    )
    data = _http_get_json(url)
    result: list[dict] = []
    if isinstance(data, dict):
        for cid in coin_ids:
            info = data.get(cid)
            if not info:
                continue
            result.append({
                "id": cid,
                "usd": info.get("usd"),
                "try": info.get("try"),
                "change_24h": info.get("usd_24h_change"),
            })
    _cache_set(key, result)
    return result


def fetch_fx(codes: list[str]) -> list[dict]:
    """open.er-api.com - USD/EUR vb. karşısında TRY."""
    if not codes:
        return []
    key = "fx:" + ",".join(sorted(codes))
    cached = _cache_get(key, ttl=120)
    if cached is not None:
        return cached

    result: list[dict] = []
    # USD bazlı al, TRY karşılığı çıkar; sonra cross kur da hesaplanabilir
    data = _http_get_json("https://open.er-api.com/v6/latest/USD")
    rates = {}
    if isinstance(data, dict) and data.get("result") == "success":
        rates = data.get("rates", {}) or {}

    try_rate = rates.get("TRY")
    if try_rate:
        for code in codes:
            if code == "USD":
                result.append({"code": "USD", "try": try_rate})
            else:
                r = rates.get(code)
                if r:
                    # 1 <code> kaç TRY: TRY/USD ÷ r/USD
                    result.append({"code": code, "try": try_rate / r})
    _cache_set(key, result)
    return result


def fetch_yahoo_quote(symbol: str) -> dict | None:
    """Yahoo Finance chart endpoint ile son fiyat ve % değişim."""
    key = f"yahoo:{symbol}"
    cached = _cache_get(key, ttl=60)
    if cached is not None:
        return cached

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?interval=1d&range=2d"
    data = _http_get_json(url)
    out = None
    try:
        res = data["chart"]["result"][0]
        meta = res.get("meta", {})
        price = meta.get("regularMarketPrice")
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        currency = meta.get("currency")
        change_pct = None
        if price is not None and prev:
            change_pct = (price - prev) / prev * 100.0
        out = {
            "symbol": symbol,
            "price": price,
            "prev_close": prev,
            "change_pct": change_pct,
            "currency": currency,
        }
    except Exception:
        out = None
    _cache_set(key, out)
    return out


def fetch_bist(tickers: list[str]) -> list[dict]:
    if not tickers:
        return []
    out: list[dict] = []
    # Paralel: her ticker icin yahoo cagrisi ayri thread
    futures = {_md_executor.submit(fetch_yahoo_quote, f"{t}.IS"): t for t in tickers}
    for fut in as_completed(futures):
        t = futures[fut]
        try:
            q = fut.result()
        except Exception:
            q = None
        if q and q.get("price") is not None:
            q["ticker"] = t
            out.append(q)
    return out


def fetch_index(codes: list[str]) -> list[dict]:
    if not codes:
        return []
    out: list[dict] = []

    def _one(c: str):
        return c, (fetch_yahoo_quote(f"^{c}") or fetch_yahoo_quote(f"{c}.IS"))

    futures = [_md_executor.submit(_one, c) for c in codes]
    for fut in as_completed(futures):
        try:
            c, q = fut.result()
        except Exception:
            continue
        if q and q.get("price") is not None:
            q["index"] = c
            out.append(q)
    return out


# ============== CONTEXT BUILDER ==============

def _fmt_num(n, digits: int = 2) -> str:
    try:
        return f"{float(n):,.{digits}f}"
    except Exception:
        return str(n)


def _fmt_pct(n) -> str:
    if n is None:
        return "-"
    try:
        return f"{float(n):+.2f}%"
    except Exception:
        return str(n)


def build_market_context(question: str) -> str | None:
    """
    Soruyu analiz eder, ilgili canlı piyasa verisini çeker ve
    LLM'e system message olarak verilecek kısa bir context
    metni döner. Veri yoksa None döner.
    """
    try:
        ents = detect_entities(question)
    except Exception:
        return None

    lines: list[str] = []

    # --- 4 farkli kaynagi PARALEL cek (toplam latency = en yavas olan) ---
    futures = {}
    if ents["index"]:
        futures["index"] = _md_executor.submit(fetch_index, ents["index"])
    if ents["bist"]:
        futures["bist"] = _md_executor.submit(fetch_bist, ents["bist"])
    if ents["crypto"]:
        futures["crypto"] = _md_executor.submit(fetch_crypto, ents["crypto"])
    if ents["fx"]:
        futures["fx"] = _md_executor.submit(fetch_fx, ents["fx"])

    results: dict[str, list[dict]] = {}
    for name, fut in futures.items():
        try:
            results[name] = fut.result(timeout=5.0) or []
        except Exception as e:
            print(f"[market_data] {name} fetch hata: {e}")
            results[name] = []

    # Endeksler (BIST 100 vb.)
    for row in results.get("index", []):
        lines.append(
            f"- {row['index']}: {_fmt_num(row['price'])} "
            f"({_fmt_pct(row['change_pct'])})"
        )

    # BIST hisseleri
    for row in results.get("bist", []):
        lines.append(
            f"- {row['ticker']} (BIST): {_fmt_num(row['price'])} TL "
            f"({_fmt_pct(row['change_pct'])})"
        )

    # Kripto
    for row in results.get("crypto", []):
        usd = row.get("usd")
        try_ = row.get("try")
        chg = row.get("change_24h")
        parts = []
        if usd is not None:
            parts.append(f"{_fmt_num(usd, 4 if usd < 1 else 2)} USD")
        if try_ is not None:
            parts.append(f"{_fmt_num(try_, 4 if try_ < 1 else 2)} TL")
        if chg is not None:
            parts.append(f"24s: {_fmt_pct(chg)}")
        lines.append(f"- {row['id'].upper()}: " + " | ".join(parts))

    # Döviz
    for row in results.get("fx", []):
        lines.append(f"- 1 {row['code']} = {_fmt_num(row['try'], 4)} TL")

    if not lines:
        return None

    from datetime import datetime
    header = (
        "📡 CANLI PİYASA VERİSİ "
        f"(alındığı an: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}):\n"
    )
    footer = (
        "\n⚠️ TALİMAT: Yukarıdaki sayılar UYGULAMA TARAFINDAN ŞU AN ÇEKİLEN "
        "CANLI piyasa verisidir. Kullanıcıya cevabında MUTLAKA bu sayıları kullan. "
        "'Gerçek zamanlı veriye erişimim yok', 'güncel fiyatı bilemem', "
        "'eğitim verim eski' gibi reddetme cümleleri KURMA — veri zaten elinde. "
        "Kendi eğitim verinden eski fiyat uydurma; sadece yukarıdaki rakamları "
        "olduğu gibi belirt ve kısa yorumla."
    )
    return header + "\n".join(lines) + footer


def has_live_data(question: str) -> bool:
    """Hızlı kontrol: soruda tespit edilebilecek bir varlık var mı?"""
    try:
        ents = detect_entities(question)
        return any(ents.values())
    except Exception:
        return False
