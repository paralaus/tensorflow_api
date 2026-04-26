"""RAG (Retrieval-Augmented Generation) paketi.

Mimari:
- embedder.py     : Lokal sentence-transformer (Turkce destekli, CPU)
- vectorstore.py  : ChromaDB (embedded, ekstra servis yok) - sonra Qdrant'a gecilebilir
- retriever.py    : query -> top-k chunk -> LLM context formatla
- ingest/         : KAP / bilanco / haber besleme worker'lari (chat path'inden bagimsiz)

Kullanim (chat path):
    from rag import retriever
    if retriever.is_relevant(q):
        ctx = retriever.retrieve(q, top_k=3)  # str veya None

Tum modul opsiyonel - bagimliliklar yoksa no-op fallback ile sessizce devre disi kalir.
"""
from __future__ import annotations

# Public API
try:
    from . import retriever  # noqa: F401
    from . import embedder   # noqa: F401
    from . import vectorstore  # noqa: F401
    RAG_AVAILABLE = True
except Exception as _e:
    print(f"[rag] init hata, RAG devre disi: {_e}")
    RAG_AVAILABLE = False
