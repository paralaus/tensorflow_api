"""Inkremental ingest icin kucuk JSON state dosyasi.

Her kaynak (kap, financials, news) icin son gorulen ID/tarih tutar.
Lokasyon: RAG_DB_DIR/_state/<source>.json

Format:
    {
        "last_index": 1234567,        # KAP disclosureIndex
        "last_publish": "2025-04-26T10:00:00",
        "updated_at": "2025-04-26T10:05:23Z",
        "stats": {"total_ingested": 4321}
    }
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from typing import Any, Optional

# vectorstore ile ayni DB_DIR'i kullan
from rag import vectorstore as _vs

_STATE_DIR = os.path.join(_vs.DB_DIR, "_state")
_lock = threading.Lock()


def _path(source: str) -> str:
    return os.path.join(_STATE_DIR, f"{source}.json")


def load(source: str) -> dict[str, Any]:
    p = _path(source)
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def save(source: str, data: dict[str, Any]) -> None:
    with _lock:
        os.makedirs(_STATE_DIR, exist_ok=True)
        data = dict(data)
        data["updated_at"] = datetime.now(timezone.utc).isoformat()
        tmp = _path(source) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(source))


def update(source: str, **fields: Any) -> dict[str, Any]:
    cur = load(source)
    cur.update(fields)
    save(source, cur)
    return cur


def bump_total(source: str, delta: int) -> None:
    cur = load(source)
    stats = cur.get("stats") or {}
    stats["total_ingested"] = int(stats.get("total_ingested", 0)) + int(delta)
    cur["stats"] = stats
    save(source, cur)
