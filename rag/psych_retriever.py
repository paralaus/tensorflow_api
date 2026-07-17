"""AI Psikolog icin RAG retriever - rag/retriever.py'nin (finans) psikoloji
karsiligi, kasitli olarak AYRI bir modul.

Neden ayri (retriever.py'yi genellemek yerine):
- retriever.py'nin konu-tetikleyici keyword filtresi (is_relevant) tamamen
  BIST/finans terimlerine kurulu; psikoloji sohbetinde anlamsiz.
- Burada terapi sohbetinin HER mesaji potansiyel olarak literatur
  baglamindan faydalanabilir, bu yuzden konu filtresi yok - sadece cok
  kisa/bos mesajlari atlayan bir esik var (RAG'e bakmaya deger yok).
- Finans RAG'i (hissechat icin canli/production) yanlislikla etkilememek
  icin embedder/vectorstore disinda hicbir kod paylasilmiyor.

Kullanim:
    from rag import psych_retriever
    ctx = psych_retriever.retrieve(message)  # None ya da formatli metin
"""
from __future__ import annotations

import os
from typing import Optional

from . import embedder, vectorstore as vs

COLLECTION = "psychology"
TOP_K = int(os.environ.get("PSYCH_RAG_TOP_K", "4"))
MIN_RELEVANCE_SIMILARITY = float(os.environ.get("PSYCH_RAG_MIN_SIM", "0.30"))
MAX_CONTEXT_CHARS = int(os.environ.get("PSYCH_RAG_MAX_CTX", "2000"))
MIN_MESSAGE_LEN = 6  # "evet"/"tamam" gibi kisa yanitlarda RAG'e bakmaya deger yok


def is_relevant(question: str) -> bool:
    return bool(question) and isinstance(question, str) and len(question.strip()) >= MIN_MESSAGE_LEN


def is_ready() -> bool:
    """Embedder + vectorstore + 'psychology' koleksiyonu dolu mu?"""
    if not vs.is_ready():
        return False
    try:
        st = vs.stats()
        return (st.get("collections", {}).get(COLLECTION, 0) or 0) > 0
    except Exception:
        return False


def retrieve(question: str, top_k: Optional[int] = None) -> Optional[str]:
    """Soru icin formatli context doner. Hicbir sonuc yoksa None."""
    if not is_relevant(question):
        return None
    if not vs.is_ready():
        return None
    vec = embedder.embed_query(question)
    if not vec:
        return None

    rows = vs.query(COLLECTION, embedding=vec, top_k=top_k or TOP_K)
    if not rows:
        return None

    rows.sort(key=lambda r: r.get("distance") if r.get("distance") is not None else 1.0)

    accepted = []
    for r in rows:
        d = r.get("distance")
        sim = (1.0 - d) if (d is not None) else 0.0
        if sim >= MIN_RELEVANCE_SIMILARITY:
            accepted.append(r)
    if not accepted:
        return None

    lines = ["📚 PSIKOLOJI BILGI BANKASI (en alakali kayitlar):"]
    used = 0
    for r in accepted:
        meta = r.get("metadata") or {}
        title = meta.get("title") or meta.get("file") or "kaynak"
        body = (r.get("document") or "").strip().replace("\n", " ")
        max_each = 420
        if len(body) > max_each:
            body = body[:max_each].rstrip() + "..."
        line = f"- [{title}] {body}"
        if used + len(line) > MAX_CONTEXT_CHARS:
            break
        lines.append(line)
        used += len(line)

    lines.append(
        "Bu bilgileri kendi klinik degerlendirmenin ve yanit tonunun bir "
        "parcasi olarak kullan; kullaniciya kaynak/alinti okuma, sadece "
        "dogal ve empatik bir yanit ver. Bilgiler soruyla ilgisizse gormezden gel."
    )
    return "\n".join(lines)


def stats() -> dict:
    return {
        "ready": is_ready(),
        "collection": COLLECTION,
        "top_k": TOP_K,
        "min_similarity": MIN_RELEVANCE_SIMILARITY,
        "embedder_loaded": embedder.is_ready(),
        "store": vs.stats() if vs.is_ready() else {"backend": "disabled"},
    }
