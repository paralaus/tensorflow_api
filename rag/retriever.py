"""Retriever: query -> relevance check -> embed -> vector search -> formatted context.

Performans tasarimi:
- is_relevant(q): keyword filtre - irrelevant sorularda RAG'i tamamen atla (latency=0).
- retrieve(q): embed (CPU 20-40ms) + chroma query (5-15ms) + format = ~50-80ms toplam.
- Birden fazla koleksiyon (kap + financials) paralel sorgulanir.
- Sonuc bos -> None doner (caller market_data gibi context eklemez).

Cikti format'i (LLM'e veriliyor):
    "📚 ILGILI BILGILER:\n- [KAP 2024-03-15 GARAN] Banka 1Q kar ...\n- ..."
"""
from __future__ import annotations

import os
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from . import embedder, vectorstore as vs

# Hangi koleksiyonlardan cekecegimiz (env ile override edilebilir).
COLLECTIONS = [c.strip() for c in os.environ.get("RAG_COLLECTIONS", "kap,financials").split(",") if c.strip()]
TOP_K_PER_COLLECTION = int(os.environ.get("RAG_TOP_K", "4"))
MIN_RELEVANCE_SIMILARITY = float(os.environ.get("RAG_MIN_SIM", "0.35"))  # cosine sim altinda dropla
MAX_CONTEXT_CHARS = int(os.environ.get("RAG_MAX_CTX", "2200"))

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="rag")

# --- RELEVANCE FILTER ---
# Bu kelimelerden biri varsa RAG'e bakiyoruz; yoksa atliyoruz (latency=0 koruma).
_KEYWORDS = re.compile(
    r"\b("
    r"bilanco|bilanço|temettu|temettü|kap|aciklama|açıklama|finansal|gelir|kar|kâr|zarar|"
    r"ceyrek|çeyrek|yillik|yıllık|rapor|denetim|sirket|şirket|halka\s+arz|halkaarz|"
    r"genel\s+kurul|sermaye|hisse\s+geri|geri\s+alim|alım|"
    # Sik gecen BIST tickerlari (genisletilebilir):
    r"thyao|garan|akbnk|isctr|ykbnk|halkb|vakbn|bimas|migros|sokm|sasa|tuprs|froto|"
    r"toaso|asels|kchol|sahol|enkai|petkm|ereli|kozaa|kozal|"
    # Sirket adlari (kisa liste; genisletilebilir veya KAP listesinden uretilebilir):
    r"garanti|akbank|i[sş]\s*bankas|yapi\s*kredi|halkbank|vakif|vakıf|"
    r"thy|t[uü]rk\s*hava\s*yollari|tofa[sş]|ford\s*otosan|aselsan|petkim|tupras|"
    r"koc\s*holding|sabanci|şahinler"
    r")\b",
    re.IGNORECASE,
)


def is_relevant(question: str) -> bool:
    """RAG'i tetiklemeye deger mi? Hizli keyword filtresi (mikrosaniye)."""
    if not question or not isinstance(question, str):
        return False
    return bool(_KEYWORDS.search(question))


def is_ready() -> bool:
    """Embedder + vectorstore + en az bir koleksiyon dolu mu?"""
    if not (embedder.is_ready() or True):  # embedder lazy - is_ready False olabilir; sorun degil
        pass
    if not vs.is_ready():
        return False
    try:
        st = vs.stats()
        cols = st.get("collections", {})
        return any(cols.get(c, 0) > 0 for c in COLLECTIONS)
    except Exception:
        return False


def _query_one(collection: str, vec: list[float], top_k: int) -> list[dict]:
    return vs.query(collection, embedding=vec, top_k=top_k)


def retrieve(question: str, top_k: Optional[int] = None) -> Optional[str]:
    """Soru icin formatli context doner. Hicbir sonuc yoksa None."""
    if not is_relevant(question):
        return None
    if not vs.is_ready():
        return None
    vec = embedder.embed_query(question)
    if not vec:
        return None
    k = top_k or TOP_K_PER_COLLECTION

    # Tum koleksiyonlari PARALEL sorgula
    futures = {c: _executor.submit(_query_one, c, vec, k) for c in COLLECTIONS}
    rows: list[dict] = []
    for c, fut in futures.items():
        try:
            rows.extend(fut.result(timeout=2.0))
        except Exception as e:
            print(f"[rag/retriever] '{c}' sorgu hata: {e}")

    if not rows:
        return None

    # En yakini once: distance kucukse daha yakin (cosine).
    rows.sort(key=lambda r: r.get("distance") if r.get("distance") is not None else 1.0)

    # Cosine distance ~ 1 - similarity. Esik altindakileri ele.
    accepted = []
    for r in rows:
        d = r.get("distance")
        sim = (1.0 - d) if (d is not None) else 0.0
        if sim >= MIN_RELEVANCE_SIMILARITY:
            r["_sim"] = sim
            accepted.append(r)
    if not accepted:
        return None

    # Format
    lines = ["📚 BILGI BANKASI (en alakali kayitlar):"]
    used = 0
    for r in accepted:
        meta = r.get("metadata") or {}
        src = meta.get("source") or meta.get("type") or "kayit"
        date = meta.get("date") or meta.get("published") or ""
        ticker = meta.get("ticker") or meta.get("symbol") or ""
        head = " ".join(x for x in [src.upper(), date, ticker] if x).strip()
        body = (r.get("document") or "").strip().replace("\n", " ")
        # Cok uzun chunk'lari kirp
        max_each = 400
        if len(body) > max_each:
            body = body[:max_each].rstrip() + "..."
        line = f"- [{head}] {body}"
        if used + len(line) > MAX_CONTEXT_CHARS:
            break
        lines.append(line)
        used += len(line)

    lines.append(
        "Bu bilgileri yanit verirken referans al ama kullanici sormadan kaynak ismini sayma. "
        "Eger bilgiler soruyla ilgili degilse gormezden gel."
    )
    return "\n".join(lines)


def stats() -> dict:
    return {
        "ready": is_ready(),
        "collections": COLLECTIONS,
        "top_k": TOP_K_PER_COLLECTION,
        "min_similarity": MIN_RELEVANCE_SIMILARITY,
        "embedder_loaded": embedder.is_ready(),
        "store": vs.stats() if vs.is_ready() else {"backend": "disabled"},
    }
