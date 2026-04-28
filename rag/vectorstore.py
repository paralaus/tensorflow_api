"""Vector store - ChromaDB (embedded, dosya tabanli, ekstra servis yok).

Koleksiyonlar:
- "kap"        : KAP duyurulari
- "financials" : Bilanco/finansal veri ozetleri
- "news"       : Haber yazilari (opsiyonel)

Kullanim:
    from rag import vectorstore as vs
    vs.upsert("kap", ids=[...], documents=[...], embeddings=[...], metadatas=[...])
    results = vs.query("kap", embedding=[...], top_k=3, filters={"ticker":"GARAN"})

Tasarim:
- Embedding'i biz uretip veriyoruz (Chroma'nin default embedding fn'i kapali) -
  boylece embedder.py ile tek model uzerinden konusuyoruz.
- Persist dir: RAG_DB_DIR env ile ayarlanabilir, default "./rag_db".
- Bagimlilik yoksa _DISABLED=True, sessizce no-op.
"""
from __future__ import annotations

import os
import threading
from typing import Optional

DB_DIR = os.environ.get("RAG_DB_DIR", os.path.join(os.path.dirname(__file__), "..", "rag_db"))
DB_DIR = os.path.abspath(DB_DIR)

_client = None
_collections: dict[str, object] = {}
_lock = threading.Lock()
_DISABLED = False


def _ensure_client():
    global _client, _DISABLED
    if _client is not None or _DISABLED:
        return
    with _lock:
        if _client is not None or _DISABLED:
            return
        try:
            os.makedirs(DB_DIR, exist_ok=True)
            # Linux/Docker: sistem sqlite3 < 3.35 olabilir; chromadb buna takiliyor.
            # pysqlite3-binary kurulu ise sys.modules'a swap edip eski sqlite3'u
            # gizleriz. Windows wheel'i yok ama orada sistem sqlite3 zaten >=3.35.
            try:
                import pysqlite3  # type: ignore
                import sys as _sys
                _sys.modules["sqlite3"] = pysqlite3
                _sys.modules["sqlite3.dbapi2"] = pysqlite3.dbapi2  # type: ignore
            except ImportError:
                pass
            import chromadb  # type: ignore
            from chromadb.config import Settings  # type: ignore

            _client = chromadb.PersistentClient(
                path=DB_DIR,
                settings=Settings(anonymized_telemetry=False, allow_reset=False),
            )
            print(f"[rag/vectorstore] ChromaDB hazir (dir={DB_DIR})")
        except ImportError:
            print("[rag/vectorstore] chromadb yuklu degil, vector store devre disi.")
            _DISABLED = True
        except Exception as e:
            print(f"[rag/vectorstore] Init hata: {e}")
            _DISABLED = True


def is_ready() -> bool:
    # Lazy-init oldugu icin ilk cagri da readiness'i gercekci gormeli.
    # Aksi halde ingest worker her zaman "hazir degil" deyip upsert'i atlar.
    _ensure_client()
    return _client is not None and not _DISABLED


def _get_collection(name: str):
    _ensure_client()
    if _DISABLED or _client is None:
        return None
    if name in _collections:
        return _collections[name]
    with _lock:
        if name in _collections:
            return _collections[name]
        try:
            # Chroma >=0.5: get_or_create
            col = _client.get_or_create_collection(
                name=name,
                metadata={"hnsw:space": "cosine"},  # normalize edilmis embeddingler icin
            )
            _collections[name] = col
            return col
        except Exception as e:
            print(f"[rag/vectorstore] collection '{name}' alinamadi: {e}")
            return None


def upsert(
    collection: str,
    ids: list[str],
    documents: list[str],
    embeddings: list[list[float]],
    metadatas: Optional[list[dict]] = None,
) -> bool:
    if not ids:
        return False
    col = _get_collection(collection)
    if col is None:
        return False
    try:
        col.upsert(
            ids=ids,
            documents=documents,
            embeddings=embeddings,
            metadatas=metadatas if metadatas is not None else [{} for _ in ids],
        )
        return True
    except Exception as e:
        print(f"[rag/vectorstore] upsert hata ({collection}): {e}")
        return False


def query(
    collection: str,
    embedding: list[float],
    top_k: int = 3,
    filters: Optional[dict] = None,
) -> list[dict]:
    """En yakin top_k chunk'i doner: [{id, document, metadata, distance}, ...]"""
    col = _get_collection(collection)
    if col is None or not embedding:
        return []
    try:
        kwargs = {
            "query_embeddings": [embedding],
            "n_results": top_k,
            "include": ["documents", "metadatas", "distances"],
        }
        if filters:
            kwargs["where"] = filters
        res = col.query(**kwargs)
        out = []
        ids = (res.get("ids") or [[]])[0]
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]
        for i in range(len(ids)):
            out.append({
                "id": ids[i],
                "document": docs[i] if i < len(docs) else "",
                "metadata": metas[i] if i < len(metas) else {},
                "distance": dists[i] if i < len(dists) else None,
            })
        return out
    except Exception as e:
        print(f"[rag/vectorstore] query hata ({collection}): {e}")
        return []


def stats() -> dict:
    _ensure_client()
    out = {"backend": "chromadb" if not _DISABLED else "disabled", "dir": DB_DIR, "collections": {}}
    if _DISABLED or _client is None:
        return out
    try:
        for col_obj in _client.list_collections():
            try:
                name = col_obj.name
                col = _get_collection(name)
                out["collections"][name] = col.count() if col else 0
            except Exception:
                pass
    except Exception:
        pass
    return out


def delete_by_filter(collection: str, filters: dict) -> int:
    """Belirli metadata filtresine uyan kayitlari sil. Geri donen: tahmini sayi."""
    col = _get_collection(collection)
    if col is None:
        return 0
    try:
        col.delete(where=filters)
        return 1
    except Exception as e:
        print(f"[rag/vectorstore] delete_by_filter hata: {e}")
        return 0
