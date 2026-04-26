"""KAP (Kamuyu Aydinlatma Platformu) duyurulari ingest worker.

Calisma:
    # Son 1 gun, canli API
    python -m rag.ingest.kap --days 1

    # Offline test - JSON fixture'dan oku
    python -m rag.ingest.kap --offline path/to/sample.json --dry-run

    # Cron (her 15 dk):
    */15 9-19 * * 1-5  cd /app && python -m rag.ingest.kap --days 1 >> /var/log/kap.log 2>&1

Notlar:
- Chat path'inden CAGRILMAZ. Tamamen offline worker.
- KAP'in resmi public API'si: https://www.kap.org.tr/tr/api/disclosures (POST JSON)
  Format degisirse parse_kap_disclosure() icindeki alanlari guncelle.
- Inkremental: state file en son gorulen disclosureIndex'i tutar.
- Embedding/upsert hatalari yutulur, batch devam eder.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

# ---- KAP API endpoint ve sabitler ----
KAP_API_URL = os.environ.get(
    "KAP_API_URL", "https://www.kap.org.tr/tr/api/disclosures"
)
KAP_USER_AGENT = os.environ.get(
    "KAP_USER_AGENT",
    "Mozilla/5.0 (compatible; AlchemyRAG/1.0; +https://alchemy.local/bot)",
)
COLLECTION = "kap"
CHUNK_SIZE = int(os.environ.get("KAP_CHUNK_SIZE", "500"))   # karakter
CHUNK_OVERLAP = int(os.environ.get("KAP_CHUNK_OVERLAP", "60"))
EMBED_BATCH = int(os.environ.get("KAP_EMBED_BATCH", "32"))
HTTP_TIMEOUT = float(os.environ.get("KAP_HTTP_TIMEOUT", "20"))
MAX_RETRIES = int(os.environ.get("KAP_HTTP_RETRIES", "3"))


# ---------------- Fetch ----------------

def fetch_kap_disclosures(
    from_date: datetime,
    to_date: datetime,
    *,
    timeout: float = HTTP_TIMEOUT,
) -> list[dict[str, Any]]:
    """KAP disclosures API'sini cagir, ham JSON listesi don.

    KAP body: {"fromDate":"YYYY-MM-DD","toDate":"YYYY-MM-DD","year":"","prd":"",
               "term":"","ruleTypeTerm":"","bdkReview":"","disclosureClass":"",
               "index":"","market":"","subjectList":[],"mkkMemberOidList":[],
               "inactiveMkkMemberOidList":[],"bdkMemberOidList":[],
               "discIndex":[],"relationType":""}
    """
    try:
        import requests  # type: ignore
    except ImportError:
        print("[kap] requests yuklu degil, fetch atlandi.", file=sys.stderr)
        return []

    payload = {
        "fromDate": from_date.strftime("%Y-%m-%d"),
        "toDate": to_date.strftime("%Y-%m-%d"),
        "year": "",
        "prd": "",
        "term": "",
        "ruleTypeTerm": "",
        "bdkReview": "",
        "disclosureClass": "",
        "index": "",
        "market": "",
        "subjectList": [],
        "mkkMemberOidList": [],
        "inactiveMkkMemberOidList": [],
        "bdkMemberOidList": [],
        "discIndex": [],
        "relationType": "",
    }
    headers = {
        "User-Agent": KAP_USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    last_err: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = requests.post(
                KAP_API_URL, json=payload, headers=headers, timeout=timeout
            )
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and "disclosures" in data:
                data = data["disclosures"]
            if not isinstance(data, list):
                print(f"[kap] beklenmeyen response tipi: {type(data)}", file=sys.stderr)
                return []
            return data
        except Exception as e:
            last_err = e
            sleep = min(2 ** attempt, 10)
            print(
                f"[kap] fetch hata (deneme {attempt}/{MAX_RETRIES}): {e}; "
                f"{sleep}s sonra tekrar.",
                file=sys.stderr,
            )
            time.sleep(sleep)
    print(f"[kap] fetch nihai hata: {last_err}", file=sys.stderr)
    return []


def load_offline_fixture(path: str) -> list[dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "disclosures" in data:
        data = data["disclosures"]
    if not isinstance(data, list):
        raise ValueError(f"Fixture liste degil: {type(data)}")
    return data


# ---------------- Normalize ----------------

_TICKER_RE = re.compile(r"\b[A-ZĞÜŞİÖÇ]{4,6}\b")


def parse_kap_disclosure(raw: dict[str, Any]) -> Optional[dict[str, Any]]:
    """KAP raw kaydi -> normalize dict.

    KAP alanlari (ornek): disclosureIndex, kapTitle, summary, publishDate,
    stockCodes, subject, basic.companyName, isOldKapMember vs.
    Format zaman zaman degisir; defansif parse.
    """
    try:
        idx = raw.get("disclosureIndex") or raw.get("index") or raw.get("id")
        if idx is None:
            return None
        idx = int(idx)

        title = (
            raw.get("kapTitle")
            or raw.get("title")
            or raw.get("subject")
            or ""
        ).strip()
        summary = (raw.get("summary") or raw.get("kapSummary") or "").strip()

        # tarih
        publish = (
            raw.get("publishDate")
            or raw.get("kapPublishDate")
            or raw.get("disclosureDate")
            or ""
        )

        # tickerlar
        tickers_raw = (
            raw.get("stockCodes")
            or raw.get("relatedStocks")
            or raw.get("memberStockCodes")
            or ""
        )
        if isinstance(tickers_raw, list):
            tickers = [str(t).strip().upper() for t in tickers_raw if t]
        else:
            tickers = [m.group(0) for m in _TICKER_RE.finditer(str(tickers_raw).upper())]
        tickers = [t for t in tickers if 3 <= len(t) <= 6]

        # company
        company = ""
        basic = raw.get("basic") or {}
        if isinstance(basic, dict):
            company = (basic.get("companyName") or basic.get("company") or "").strip()
        company = company or (raw.get("companyName") or "").strip()

        body = title
        if summary:
            body = f"{title}\n\n{summary}" if title else summary
        if not body:
            return None

        return {
            "index": idx,
            "title": title,
            "body": body,
            "publish": str(publish),
            "tickers": tickers,
            "company": company,
        }
    except Exception as e:
        print(f"[kap] parse hata id={raw.get('disclosureIndex')}: {e}", file=sys.stderr)
        return None


# ---------------- Chunk ----------------

def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    chunks: list[str] = []
    i = 0
    while i < len(text):
        chunks.append(text[i : i + size])
        if i + size >= len(text):
            break
        i += max(1, size - overlap)
    return chunks


def make_chunks(item: dict[str, Any]) -> list[dict[str, Any]]:
    """Tek duyurudan (id, document, metadata) chunk listesi uret."""
    parts = chunk_text(item["body"])
    out: list[dict[str, Any]] = []
    for i, part in enumerate(parts):
        # ID = disclosureIndex + chunk no + content hash (idempotent upsert)
        h = hashlib.sha1(part.encode("utf-8")).hexdigest()[:8]
        cid = f"kap-{item['index']}-{i}-{h}"
        meta = {
            "source": "kap",
            "disclosure_index": item["index"],
            "chunk": i,
            "title": item["title"][:200],
            "publish": item["publish"][:32],
            "ticker": ",".join(item["tickers"][:6]),
            "company": item["company"][:120],
        }
        out.append({"id": cid, "document": part, "metadata": meta})
    return out


# ---------------- Run ----------------

def ingest(
    rows: list[dict[str, Any]],
    *,
    dry_run: bool = False,
    last_seen_index: int = 0,
) -> dict[str, Any]:
    """Parse + chunk + embed + upsert. Inkremental filtre last_seen_index uzerinden."""
    parsed: list[dict[str, Any]] = []
    skipped_old = 0
    skipped_bad = 0
    for raw in rows:
        item = parse_kap_disclosure(raw)
        if item is None:
            skipped_bad += 1
            continue
        if item["index"] <= last_seen_index:
            skipped_old += 1
            continue
        parsed.append(item)

    chunks: list[dict[str, Any]] = []
    for it in parsed:
        chunks.extend(make_chunks(it))

    max_index = max((p["index"] for p in parsed), default=last_seen_index)
    max_publish = max((p["publish"] for p in parsed), default="")

    summary = {
        "fetched": len(rows),
        "parsed": len(parsed),
        "chunks": len(chunks),
        "skipped_old": skipped_old,
        "skipped_bad": skipped_bad,
        "upserted": 0,
        "max_index": max_index,
        "max_publish": max_publish,
        "dry_run": dry_run,
    }

    if not chunks:
        return summary

    if dry_run:
        print(f"[kap] dry-run: {len(chunks)} chunk uretildi, ornek:")
        for c in chunks[:3]:
            print(f"  - {c['id']}  meta={c['metadata']}  body={c['document'][:80]!r}")
        return summary

    # Lazy import - dry-run'da chromadb/ST gereksinimi yok
    from rag import embedder, vectorstore as vs

    if not embedder.is_ready():
        embedder._ensure_loaded()  # type: ignore[attr-defined]
    if not embedder.is_ready():
        print("[kap] embedder hazir degil (sentence-transformers kurulu mu?), upsert iptal.", file=sys.stderr)
        return summary
    if not vs.is_ready():
        print("[kap] vectorstore hazir degil (chromadb / sqlite), upsert iptal.", file=sys.stderr)
        return summary

    docs = [c["document"] for c in chunks]
    embs = embedder.embed_batch(docs, batch_size=EMBED_BATCH)
    if not embs or len(embs) != len(chunks):
        print(f"[kap] embed_batch beklenmedik sonuc: {len(embs)}/{len(chunks)}", file=sys.stderr)
        return summary

    ok = vs.upsert(
        COLLECTION,
        ids=[c["id"] for c in chunks],
        documents=docs,
        embeddings=embs,
        metadatas=[c["metadata"] for c in chunks],
    )
    if ok:
        summary["upserted"] = len(chunks)
    return summary


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="KAP duyurulari ingest worker")
    p.add_argument("--days", type=int, default=1, help="Kac gun geriye gidilsin (default 1)")
    p.add_argument("--limit", type=int, default=0, help="Max kayit sayisi (0=hepsi)")
    p.add_argument("--offline", type=str, default="", help="Canli API yerine JSON fixture")
    p.add_argument("--dry-run", action="store_true", help="Embed/upsert yapma, sadece raporla")
    p.add_argument("--full", action="store_true", help="State sifirla, hepsini yeniden cek")
    args = p.parse_args(argv)

    from rag.ingest import _state

    state = _state.load("kap")
    last_idx = 0 if args.full else int(state.get("last_index") or 0)
    print(f"[kap] state: last_index={last_idx}, total_ingested={(state.get('stats') or {}).get('total_ingested', 0)}")

    # Fetch
    if args.offline:
        rows = load_offline_fixture(args.offline)
        print(f"[kap] offline fixture: {len(rows)} kayit")
    else:
        to_d = datetime.now(timezone.utc)
        from_d = to_d - timedelta(days=max(1, args.days))
        rows = fetch_kap_disclosures(from_d, to_d)
        print(f"[kap] canli fetch: {from_d.date()} -> {to_d.date()}, {len(rows)} kayit")

    if args.limit and len(rows) > args.limit:
        rows = rows[: args.limit]

    summary = ingest(rows, dry_run=args.dry_run, last_seen_index=last_idx)
    print(f"[kap] sonuc: {json.dumps(summary, ensure_ascii=False)}")

    # State guncelle
    if not args.dry_run and summary["upserted"] > 0:
        _state.update(
            "kap",
            last_index=int(summary["max_index"]),
            last_publish=summary["max_publish"],
        )
        _state.bump_total("kap", summary["upserted"])

    return 0


if __name__ == "__main__":
    sys.exit(main())
