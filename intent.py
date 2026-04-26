"""
Intent / entity tespiti — TR morfoloji-aware.

Sorun: "if 'bist' in q" gibi naive substring match Turkce'de yanlis sonuc verir:
  - "hisseler", "hisseyi", "hisseye" → "hisse" stem'i ile yakalanmali
  - "borsaya", "borsada" → "bors" prefix'i
  - "akbnk'in", "GARAN.E" → ticker regex'i

Cozum:
  1. ASCII-fold + lowercase + tokenize (TR-aware: i/I/i/I)
  2. Her intent icin STEM listesi (kelime BAŞLANGICI ile esleştirilir, min 3 char)
  3. Ticker'lar orijinal metinden buyuk harf regex ile cekilir
  4. Opsiyonel: embedder hazirsa semantik benzerlik (cosine) ile sinir vakalari yakalanir

Zero extra dependency. Embedder yoksa graceful (sadece kural-tabanli).
"""
from __future__ import annotations

import os
import re
import threading
from typing import Dict, List, Optional, Set, Tuple

# ---------- TR ASCII-fold ----------
_TR_FOLD = str.maketrans({
    "ı": "i", "İ": "i", "I": "i", "i": "i",
    "ş": "s", "Ş": "s",
    "ğ": "g", "Ğ": "g",
    "ü": "u", "Ü": "u",
    "ö": "o", "Ö": "o",
    "ç": "c", "Ç": "c",
})

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_TICKER_RE = re.compile(r"\b([A-Z]{4,6})\b")  # BIST kodlari 4-6 harf


def normalize(text: str) -> str:
    if not text:
        return ""
    return text.translate(_TR_FOLD).lower()


def tokenize(text: str) -> List[str]:
    return _TOKEN_RE.findall(normalize(text))


def extract_tickers(text: str) -> List[str]:
    """Orijinal metinden buyuk harf BIST kodlarini cek (THYAO, GARAN, ASELS...).
    Common false positives elendi (TURK, BANK, vb degil — yalnizca yaygın TR kodlari)."""
    if not text:
        return []
    raw = _TICKER_RE.findall(text)
    # Yaygın false positive blacklist
    blacklist = {"BIST", "BORSA", "TURK", "BANK", "GRUP", "HOLD", "SAN", "TIC", "USD", "EUR"}
    return [t for t in raw if t not in blacklist]


# ---------- INTENT STEM TABLOSU ----------
# Anahtar: intent adi. Deger: TR-fold prefix listesi (min 3 char).
# Kelime bu prefix ile basliyorsa eslesir → "hisse"/"hisseler"/"hissesi" hepsi "hiss".
_INTENT_STEMS: Dict[str, List[str]] = {
    "stocks": [
        "hiss",      # hisse, hisseler, hisseye, hissesi
        "bors",      # borsa, borsada, borsaya
        "bist",      # bist, bist100
        "endek",     # endeks, endekse
        "tahta",     # tahta, tahtada
        "viop",
        "pay",       # pay, paylar (kisa - dikkatli kullan)
    ],
    "analysis": [
        "anali",     # analiz, analize
        "tekni",     # teknik, teknige
        "temel",
        "deger",     # deger, degerleme, degerli
        "rsi",
        "macd",
        "bilan",     # bilanco, bilancosu, bilancoya
        "fava",      # FAVOK, favok
        "fk",
        "pd",
    ],
    "compare": [
        "karsi",     # karsilastir, karsilastirma
        "fark",
        "hangi",     # hangisi
        "yoks",      # mı yoksa, yoksa
        "ara",       # ara, arasinda  - dikkat: kisa
    ],
    "crypto": [
        "bitco",     # bitcoin
        "btc",
        "ether",     # ethereum, ethere
        "eth",
        "krip",      # kripto, kriptoda, kriptolar
        "coin",
        "altco",     # altcoin
        "binan",     # binance
        "blockc",    # blockchain
    ],
    "fx": [
        "dolar",
        "euro",
        "doviz",
        "kur",       # kur, kuru, kurda
        "usd",
        "eur",
        "sterl",     # sterlin
        "yen",
        "altin",     # altin, altina
        "gumus",
        "para",      # para, parayi
    ],
    "news": [
        "kap",       # KAP duyurusu
        "duyu",      # duyuru, duyurdu
        "haber",
        "aciklam",   # aciklama, aciklamasi
        "bulten",
        "rapor",
    ],
    "dividend": [
        "temet",     # temettu, temettusu
        "kar pay",
        "bedels",    # bedelsiz
        "bedell",    # bedelli
        "halka",     # halka arz
    ],
}


_VS = ["v", "vs", "versus"]  # tek kelime karsilastirma operatoru


def _matches_stem(tokens: List[str], stems: List[str]) -> bool:
    for tok in tokens:
        for st in stems:
            if tok.startswith(st):
                return True
    return False


def detect_intents(text: str) -> Set[str]:
    """Sorudan tetiklenen intent etiketlerini dondur. TR morfoloji-aware."""
    if not text:
        return set()
    tokens = tokenize(text)
    if not tokens:
        return set()

    intents: Set[str] = set()
    for intent, stems in _INTENT_STEMS.items():
        if _matches_stem(tokens, stems):
            intents.add(intent)

    # Karsilastirma: tek harf "v"/"vs" veya orijinalde "X vs Y" pattern'i
    if "compare" not in intents:
        if any(t in _VS for t in tokens):
            intents.add("compare")

    # Hisse intent: ticker varsa otomatik
    tickers = extract_tickers(text)
    if tickers:
        intents.add("stocks")

    return intents


def extract_entities(text: str) -> Dict[str, List[str]]:
    """Yapili entity dump - downstream RAG/log icin yararli."""
    return {
        "tickers": extract_tickers(text),
        "intents": sorted(detect_intents(text)),
        "tokens": tokenize(text),
    }


# ---------- AKSIYON BUTON URETICI ----------
# Intent → (label, icon, action) eslemesi. Sirali (ekleme sirasinda gorunur).
_ACTION_MAP: List[Tuple[str, Dict[str, str]]] = [
    ("stocks",   {"label": "Grafik Gor",        "icon": "📊", "action": "showChart"}),
    ("analysis", {"label": "Detayli Analiz",    "icon": "📈", "action": "detailedAnalysis"}),
    ("compare",  {"label": "Karsilastir",       "icon": "⚖️", "action": "compareStocks"}),
    ("crypto",   {"label": "Kripto Fiyatlari",  "icon": "₿",  "action": "cryptoPrices"}),
    ("fx",       {"label": "Doviz Kurlari",     "icon": "💱", "action": "exchangeRates"}),
    ("news",     {"label": "KAP Duyurulari",    "icon": "📰", "action": "kapNews"}),
    ("dividend", {"label": "Temettu Takvimi",   "icon": "💰", "action": "dividendCalendar"}),
]


def generate_actions(question: str) -> List[Dict[str, str]]:
    """Soruya gore aksiyon butonlari uret - intent tabanli, TR morfoloji-aware."""
    intents = detect_intents(question)
    return [meta for key, meta in _ACTION_MAP if key in intents]


# ---------- OPSIYONEL: SEMANTIK FALLBACK ----------
# Embedder hazirsa, kurallar HIC eslesmediyse semantik benzerlik dener.
# Latency: ~30-50ms (embed + cosine). Cache'lenir.
SEMANTIC_FALLBACK = os.environ.get("INTENT_SEMANTIC_FALLBACK", "true").lower() == "true"
SEMANTIC_THRESHOLD = float(os.environ.get("INTENT_SEMANTIC_THRESHOLD", "0.55"))

# Her intent icin prototip cumleler (anchor'lar). Embed et, cache'le.
_INTENT_PROTOTYPES: Dict[str, List[str]] = {
    "stocks":   ["hisse senedi nasil alinir", "borsa istanbul kapanis", "bist 100 endeksi"],
    "analysis": ["teknik analiz nedir", "rsi gostergesi yorumu", "bilanco analizi"],
    "compare":  ["iki hisseyi karsilastir", "hangisi daha iyi", "X mi Y mi"],
    "crypto":   ["bitcoin fiyati", "ethereum analizi", "kripto piyasasi"],
    "fx":       ["dolar kuru ne kadar", "euro tl paritesi", "altin gram fiyati"],
    "news":     ["son KAP duyurusu", "sirket haberleri", "ozel durum aciklamasi"],
    "dividend": ["temettu odemesi ne zaman", "bedelsiz sermaye artirimi"],
}

_proto_lock = threading.Lock()
_proto_embeds: Optional[Dict[str, list]] = None  # intent → ortalama embedding


def _get_proto_embeds():
    """Lazy: prototip cumleleri embed et ve intent basina ortalama vektoru cache'le."""
    global _proto_embeds
    if _proto_embeds is not None:
        return _proto_embeds
    with _proto_lock:
        if _proto_embeds is not None:
            return _proto_embeds
        try:
            from rag import embedder as _emb  # type: ignore
        except Exception:
            return None
        if not _emb.is_ready():
            try:
                _emb._ensure_loaded()  # type: ignore[attr-defined]
            except Exception:
                return None
            if not _emb.is_ready():
                return None
        result: Dict[str, list] = {}
        for intent, sentences in _INTENT_PROTOTYPES.items():
            vecs = _emb.embed_batch(sentences)
            if not vecs:
                continue
            # Ortalama vektor (normalize edilmis embedding'lerin ortalamasi yine yon korur)
            dim = len(vecs[0])
            avg = [sum(v[i] for v in vecs) / len(vecs) for i in range(dim)]
            # L2 normalize
            norm = sum(x * x for x in avg) ** 0.5 or 1.0
            result[intent] = [x / norm for x in avg]
        _proto_embeds = result
        return _proto_embeds


def _cosine(a: list, b: list) -> float:
    s = 0.0
    for x, y in zip(a, b):
        s += x * y
    return s


def detect_intents_semantic(text: str, threshold: Optional[float] = None) -> Set[str]:
    """Kural-tabanli + (opsiyonel) semantik fallback.
    Kurallar bos donerse embedder ile en yakin intent(ler)i ekler.
    """
    intents = detect_intents(text)
    if intents or not SEMANTIC_FALLBACK:
        return intents
    protos = _get_proto_embeds()
    if not protos:
        return intents
    try:
        from rag import embedder as _emb  # type: ignore
        qvec = _emb.embed_query(text)
    except Exception:
        return intents
    if not qvec:
        return intents
    th = threshold if threshold is not None else SEMANTIC_THRESHOLD
    for intent, pvec in protos.items():
        if _cosine(qvec, pvec) >= th:
            intents.add(intent)
    return intents


# ---------- CLI ----------
if __name__ == "__main__":
    import sys
    samples = sys.argv[1:] or [
        "GARAN bilancosu nasil?",
        "borsada hisseleri nasil takip edebilirim",
        "BTC vs ETH hangisi daha iyi",
        "dolar kuru bugun ne kadar",
        "RSI nedir",
        "THYAO temettu odemesi ne zaman",
        "merhaba nasilsin",
    ]
    for s in samples:
        ent = extract_entities(s)
        acts = generate_actions(s)
        print(f"\nQ: {s}")
        print(f"  entities: {ent}")
        print(f"  actions:  {[a['action'] for a in acts]}")
