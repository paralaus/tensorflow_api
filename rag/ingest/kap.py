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
from urllib.parse import urlencode, urlparse, parse_qsl
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

# ---- KAP API endpoint ve sabitler ----
KAP_API_URL = os.environ.get(
    "KAP_API_URL", "https://www.kap.org.tr/tr/api/disclosures"
)
KAP_API_FALLBACK_URLS = [
    u.strip()
    for u in os.environ.get("KAP_API_FALLBACK_URLS", "https://www.kap.org.tr/en/api/disclosures").split(",")
    if u.strip()
]
KAP_ORIGIN = os.environ.get("KAP_ORIGIN", "https://www.kap.org.tr")
KAP_REFERER = os.environ.get("KAP_REFERER", "https://www.kap.org.tr/tr/Bildirimler")
KAP_WARMUP_URL = os.environ.get("KAP_WARMUP_URL", "https://www.kap.org.tr/tr")
KAP_NEWS_FALLBACK_URLS = [
    u.strip()
    for u in os.environ.get(
        "KAP_NEWS_FALLBACK_URLS",
        "https://hissechat-4u7pv.ondigitalocean.app/v1/markets/news?sortBy=published:desc&limit=50&page=1",
    ).split(",")
    if u.strip()
]
KAP_USER_AGENT = os.environ.get(
    "KAP_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
)
COLLECTION = "kap"
CHUNK_SIZE = int(os.environ.get("KAP_CHUNK_SIZE", "500"))   # karakter
CHUNK_OVERLAP = int(os.environ.get("KAP_CHUNK_OVERLAP", "60"))
EMBED_BATCH = int(os.environ.get("KAP_EMBED_BATCH", "32"))
HTTP_TIMEOUT = float(os.environ.get("KAP_HTTP_TIMEOUT", "20"))
HTTP_CONNECT_TIMEOUT = float(os.environ.get("KAP_HTTP_CONNECT_TIMEOUT", "10"))
MAX_RETRIES = int(os.environ.get("KAP_HTTP_RETRIES", "3"))
# Primary KAP endpoint retry policy (fail-fast when backend fallback exists)
KAP_PRIMARY_MAX_RETRIES = int(os.environ.get("KAP_PRIMARY_MAX_RETRIES", "1"))


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

    headers = {
        "User-Agent": KAP_USER_AGENT,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Origin": KAP_ORIGIN,
        "Referer": KAP_REFERER,
        "X-Requested-With": "XMLHttpRequest",
    }
    api_urls = [KAP_API_URL] + [u for u in KAP_API_FALLBACK_URLS if u != KAP_API_URL]

    def _new_session():
        sess = requests.Session()
        sess.headers.update(headers)
        # Keep container environment proxy vars from breaking direct egress unexpectedly.
        sess.trust_env = False
        if KAP_WARMUP_URL:
            try:
                sess.get(KAP_WARMUP_URL, timeout=(HTTP_CONNECT_TIMEOUT, min(timeout, 15)))
            except Exception:
                pass
        return sess

    session = _new_session()

    def _single_request(day_from: datetime, day_to: datetime) -> list[dict[str, Any]]:
        nonlocal session
        payload = {
            "fromDate": day_from.strftime("%Y-%m-%d"),
            "toDate": day_to.strftime("%Y-%m-%d"),
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

        last_err: Optional[Exception] = None
        retry_budget = KAP_PRIMARY_MAX_RETRIES if KAP_NEWS_FALLBACK_URLS else MAX_RETRIES
        retry_budget = max(1, retry_budget)
        for attempt in range(1, retry_budget + 1):
            try:
                last_url_err: Optional[Exception] = None
                for url in api_urls:
                    try:
                        r = session.post(
                            url,
                            json=payload,
                            timeout=(HTTP_CONNECT_TIMEOUT, timeout),
                        )
                        r.raise_for_status()
                        data = r.json()
                        if isinstance(data, dict) and "disclosures" in data:
                            data = data["disclosures"]
                        if not isinstance(data, list):
                            print(
                                f"[kap] beklenmeyen response tipi ({day_from.date()} url={url}): {type(data)}",
                                file=sys.stderr,
                            )
                            continue
                        return data
                    except Exception as e_url:
                        last_url_err = e_url
                        continue
                if last_url_err:
                    raise last_url_err
            except Exception as e:
                last_err = e
                sleep = min(2 ** attempt, 10)
                print(
                    f"[kap] fetch hata {day_from.date()} (deneme {attempt}/{retry_budget}): {e}; "
                    f"{sleep}s sonra tekrar.",
                    file=sys.stderr,
                )
                try:
                    session.close()
                except Exception:
                    pass
                session = _new_session()
                time.sleep(sleep)
        print(f"[kap] fetch nihai hata {day_from.date()}: {last_err}", file=sys.stderr)
        return []

    def _fetch_backend_news_fallback(day_from: datetime, day_to: datetime) -> list[dict[str, Any]]:
        if not KAP_NEWS_FALLBACK_URLS:
            return []
        last_err: Optional[Exception] = None
        for fallback_url in KAP_NEWS_FALLBACK_URLS:
            try:
                parsed = urlparse(fallback_url)
                q = dict(parse_qsl(parsed.query))
                q.setdefault("sortBy", "published:desc")
                q.setdefault("limit", "50")
                q.setdefault("page", "1")
                # backend validation: limit must be <= 50
                try:
                    q["limit"] = str(max(1, min(50, int(q.get("limit", "50")))))
                except Exception:
                    q["limit"] = "50"
                base_url = parsed._replace(query="", fragment="").geturl()
                url = f"{base_url}?{urlencode(q)}"
                r = session.get(url, timeout=(HTTP_CONNECT_TIMEOUT, timeout))
                r.raise_for_status()
                payload = r.json()
                rows = []
                if isinstance(payload, list):
                    rows = payload
                elif isinstance(payload, dict):
                    if isinstance(payload.get("results"), list):
                        rows = payload.get("results") or []
                    elif isinstance(payload.get("docs"), list):
                        rows = payload.get("docs") or []
                    elif isinstance(payload.get("items"), list):
                        rows = payload.get("items") or []

                out_rows: list[dict[str, Any]] = []
                for it in rows:
                    if not isinstance(it, dict):
                        continue
                    published = str(it.get("published") or "")
                    # Date filter (day precision) to match KAP fetch window.
                    if published and len(published) >= 10:
                        pdate = published[:10]
                        if pdate < day_from.strftime("%Y-%m-%d") or pdate > day_to.strftime("%Y-%m-%d"):
                            continue
                    ext_id = str(it.get("externalId") or it.get("id") or "")
                    if not ext_id:
                        ext_id = hashlib.sha1(
                            (str(it.get("title") or "") + "|" + published).encode("utf-8")
                        ).hexdigest()[:16]
                    idx = int(hashlib.sha1(ext_id.encode("utf-8")).hexdigest()[:12], 16)
                    rel = it.get("relatedSymbols") or []
                    tickers = []
                    if isinstance(rel, list):
                        for s in rel:
                            if isinstance(s, dict):
                                sym = str(s.get("symbol") or "").strip().upper()
                                if sym:
                                    tickers.append(sym)
                    out_rows.append(
                        {
                            "disclosureIndex": idx,
                            "kapTitle": str(it.get("title") or "").strip(),
                            "summary": str(it.get("content") or "").strip(),
                            "publishDate": published,
                            "stockCodes": ",".join(tickers),
                            "companyName": str(it.get("source") or "").strip(),
                        }
                    )
                print(f"[kap] fallback(news api) url={base_url} kayit: {len(out_rows)}", file=sys.stderr)
                return out_rows
            except Exception as e:
                last_err = e
                print(f"[kap] fallback(news api) url={fallback_url} hata: {e}", file=sys.stderr)
                continue
        if last_err:
            print(f"[kap] fallback(news api) tum URL'ler basarisiz: {last_err}", file=sys.stderr)
        return []

    # Daha stabil: tek seferde genis tarih araligi yerine gun gun istek at.
    # Boylece buyuk payload/slow response kaynakli timeout riski azalir.
    day = datetime(from_date.year, from_date.month, from_date.day, tzinfo=timezone.utc)
    day_end = datetime(to_date.year, to_date.month, to_date.day, tzinfo=timezone.utc)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    while day <= day_end:
        rows = _single_request(day, day)
        for row in rows:
            rid = str(
                row.get("disclosureIndex")
                or row.get("index")
                or row.get("id")
                or hash(json.dumps(row, ensure_ascii=False, sort_keys=True))
            )
            if rid in seen:
                continue
            seen.add(rid)
            out.append(row)
        day = day + timedelta(days=1)
    if not out:
        # Final fallback: backend market-news endpoint (TradingView provider=kap path).
        out = _fetch_backend_news_fallback(from_date, to_date)
    return out


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

    def _log_rag_runtime_state(stage: str) -> None:
        try:
            e_ready = embedder.is_ready()
        except Exception:
            e_ready = False
        try:
            v_stats = vs.stats()
        except Exception as _se:
            v_stats = {"error": str(_se)}
        print(
            f"[kap][diag] stage={stage} embedder_ready={e_ready} "
            f"vectorstore={json.dumps(v_stats, ensure_ascii=False)}"
        )

    if not embedder.is_ready():
        _log_rag_runtime_state("before_embedder_load")
        embedder._ensure_loaded()  # type: ignore[attr-defined]
    if not embedder.is_ready():
        _log_rag_runtime_state("embedder_not_ready")
        print("[kap] embedder hazir degil (sentence-transformers kurulu mu?), upsert iptal.", file=sys.stderr)
        return summary
    if not vs.is_ready():
        _log_rag_runtime_state("vectorstore_not_ready")
        print("[kap] vectorstore hazir degil (chromadb / sqlite), upsert iptal.", file=sys.stderr)
        return summary

    docs = [c["document"] for c in chunks]
    embs = embedder.embed_batch(docs, batch_size=EMBED_BATCH)
    if not embs or len(embs) != len(chunks):
        _log_rag_runtime_state("embed_batch_mismatch")
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
        _log_rag_runtime_state("upsert_ok")
    else:
        _log_rag_runtime_state("upsert_failed")
    return summary


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="KAP duyurulari ingest worker")
    p.add_argument(
        "--days",
        type=int,
        default=int(os.environ.get("KAP_INGEST_DAYS", "1")),
        help="Kac gun geriye gidilsin (0=sadece bugun, default env:KAP_INGEST_DAYS ya da 1)",
    )
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
        days_back = max(0, int(args.days))
        from_d = to_d - timedelta(days=days_back)
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
