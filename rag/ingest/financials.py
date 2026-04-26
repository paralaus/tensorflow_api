"""Bilanco / finansal veri ingest worker.

Calisma:
    # Offline fixture
    python -m rag.ingest.financials --offline rag/ingest/sample_financials.json --dry-run

    # Canli (mynet finans scrape veya FMP API)
    python -m rag.ingest.financials --tickers GARAN,THYAO,ASELS --periods 4

Tasarim:
- Kaynak (mynet/fmp/manual) eklenebilir; default sadece offline + manual fixture.
- Veri sema: her kayit bir sirket-donem (ticker x period). Tek satir, chunk yok.
- Embedding girdisi: TR ozet metni ("GARAN 2025-4Ç: hasilat ... net kar ...").
- Collection: "financials", id: financials-{TICKER}-{period}
- Idempotent: ayni period yeniden upsert edilirse uzerine yazar.

Format (her kayit):
    {
      "ticker": "GARAN",
      "period": "2025-Q4",          # yyyy-Qn veya yyyy-FY
      "period_end": "2025-12-31",
      "currency": "TRY",
      "company": "Turkiye Garanti Bankasi A.S.",
      "metrics": {
        "hasilat": 250000000000,
        "brut_kar": 95000000000,
        "faaliyet_kari": 60000000000,
        "net_kar": 45000000000,
        "favok": 70000000000,
        "toplam_aktif": 1900000000000,
        "ozsermaye": 280000000000
      },
      "notes": ""                    # opsiyonel ek text
    }
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Optional

COLLECTION = "financials"
EMBED_BATCH = int(os.environ.get("FIN_EMBED_BATCH", "32"))


# ---------------- Format helpers ----------------

_METRIC_LABELS = {
    "hasilat": "hasilat",
    "satis_geliri": "satis geliri",
    "brut_kar": "brut kar",
    "faaliyet_kari": "faaliyet kari",
    "net_kar": "net kar",
    "favok": "FAVOK",
    "toplam_aktif": "toplam aktif",
    "ozsermaye": "ozsermaye",
    "yatirim_harcamasi": "yatirim harcamasi",
    "nakit_akisi": "nakit akisi",
    "borc": "toplam borc",
}


def _fmt_amount(v: Any, currency: str = "TRY") -> Optional[str]:
    """1234500000000 -> '1,2 trilyon TRY' gibi insan-okur format."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x == 0:
        return f"0 {currency}"
    sign = "-" if x < 0 else ""
    a = abs(x)
    if a >= 1e12:
        return f"{sign}{a/1e12:.2f} trilyon {currency}"
    if a >= 1e9:
        return f"{sign}{a/1e9:.2f} milyar {currency}"
    if a >= 1e6:
        return f"{sign}{a/1e6:.2f} milyon {currency}"
    if a >= 1e3:
        return f"{sign}{a/1e3:.2f} bin {currency}"
    return f"{sign}{a:.0f} {currency}"


def build_summary(rec: dict[str, Any]) -> str:
    """Bir kayitin embedding'e gidecek TR ozet metnini uretir."""
    ticker = (rec.get("ticker") or "").upper().strip()
    period = (rec.get("period") or "").strip()
    company = (rec.get("company") or "").strip()
    currency = (rec.get("currency") or "TRY").upper()
    metrics = rec.get("metrics") or {}
    notes = (rec.get("notes") or "").strip()

    parts: list[str] = []
    head = f"{ticker} {period} bilanco/finansal"
    if company:
        head += f" - {company}"
    parts.append(head + ":")

    metric_lines: list[str] = []
    for key, label in _METRIC_LABELS.items():
        if key in metrics:
            f = _fmt_amount(metrics[key], currency)
            if f:
                metric_lines.append(f"{label} {f}")
    # Bilinmeyen metrikleri de ekle
    for key, val in metrics.items():
        if key in _METRIC_LABELS:
            continue
        f = _fmt_amount(val, currency)
        if f:
            metric_lines.append(f"{key} {f}")

    if metric_lines:
        parts.append(", ".join(metric_lines) + ".")
    if notes:
        parts.append(notes)
    return " ".join(parts)


# ---------------- Validation / normalize ----------------

def parse_record(raw: dict[str, Any]) -> Optional[dict[str, Any]]:
    try:
        ticker = (raw.get("ticker") or "").upper().strip()
        period = (raw.get("period") or "").strip()
        if not ticker or not period:
            return None
        metrics = raw.get("metrics") or {}
        if not isinstance(metrics, dict) or not metrics:
            # metricsiz kayit anlamsiz
            return None
        return {
            "ticker": ticker,
            "period": period,
            "period_end": (raw.get("period_end") or "").strip(),
            "currency": (raw.get("currency") or "TRY").upper(),
            "company": (raw.get("company") or "").strip(),
            "metrics": metrics,
            "notes": (raw.get("notes") or "").strip(),
        }
    except Exception as e:
        print(f"[fin] parse hata: {e}", file=sys.stderr)
        return None


def make_doc(rec: dict[str, Any]) -> dict[str, Any]:
    """Tek kayit -> {id, document, metadata}."""
    cid = f"financials-{rec['ticker']}-{rec['period']}"
    summary = build_summary(rec)
    meta = {
        "source": "financials",
        "ticker": rec["ticker"],
        "period": rec["period"],
        "period_end": rec["period_end"][:32],
        "currency": rec["currency"],
        "company": rec["company"][:120],
    }
    return {"id": cid, "document": summary, "metadata": meta}


# ---------------- Fetchers ----------------

def load_offline_fixture(path: str) -> list[dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and "records" in data:
        data = data["records"]
    if not isinstance(data, list):
        raise ValueError(f"Fixture liste degil: {type(data)}")
    return data


def fetch_mynet(tickers: list[str], periods: int = 4) -> list[dict[str, Any]]:
    """MyNet Finans scrape stub.

    Production'da BeautifulSoup ile https://finans.mynet.com/borsa/hisseler/{ticker}/mali-tablolar
    sayfasini parse et. Burada placeholder - canli scrape implementasyonu sonra
    eklenir; failsafe olarak bos liste don.
    """
    print(
        "[fin] mynet fetcher henuz implement edilmedi - boş liste donuyor. "
        "Manual fixture veya FMP fetcher kullan.",
        file=sys.stderr,
    )
    return []


# ---------------- Run ----------------

def ingest(
    rows: list[dict[str, Any]],
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    parsed: list[dict[str, Any]] = []
    skipped_bad = 0
    for raw in rows:
        rec = parse_record(raw)
        if rec is None:
            skipped_bad += 1
            continue
        parsed.append(rec)

    docs = [make_doc(r) for r in parsed]

    summary = {
        "fetched": len(rows),
        "parsed": len(parsed),
        "skipped_bad": skipped_bad,
        "upserted": 0,
        "dry_run": dry_run,
    }

    if not docs:
        return summary

    if dry_run:
        print(f"[fin] dry-run: {len(docs)} kayit hazir, ornek:")
        for d in docs[:3]:
            print(f"  - {d['id']}")
            print(f"      meta={d['metadata']}")
            print(f"      summary={d['document'][:160]!r}")
        return summary

    from rag import embedder, vectorstore as vs

    if not embedder.is_ready():
        embedder._ensure_loaded()  # type: ignore[attr-defined]
    if not embedder.is_ready():
        print("[fin] embedder hazir degil, upsert iptal.", file=sys.stderr)
        return summary
    if not vs.is_ready():
        print("[fin] vectorstore hazir degil, upsert iptal.", file=sys.stderr)
        return summary

    texts = [d["document"] for d in docs]
    embs = embedder.embed_batch(texts, batch_size=EMBED_BATCH)
    if not embs or len(embs) != len(docs):
        print(f"[fin] embed_batch sonuc beklenmedik: {len(embs)}/{len(docs)}", file=sys.stderr)
        return summary

    ok = vs.upsert(
        COLLECTION,
        ids=[d["id"] for d in docs],
        documents=texts,
        embeddings=embs,
        metadatas=[d["metadata"] for d in docs],
    )
    if ok:
        summary["upserted"] = len(docs)
    return summary


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Bilanco / finansal veri ingest worker")
    p.add_argument("--offline", type=str, default="", help="Canli fetch yerine JSON fixture")
    p.add_argument("--tickers", type=str, default="", help="Virgulle ayrilmis tickerlar (mynet)")
    p.add_argument("--periods", type=int, default=4, help="Cekilecek son ceyrek sayisi")
    p.add_argument("--dry-run", action="store_true", help="Embed/upsert yapma, sadece raporla")
    args = p.parse_args(argv)

    from rag.ingest import _state

    state = _state.load("financials")
    print(f"[fin] state: total_ingested={(state.get('stats') or {}).get('total_ingested', 0)}")

    if args.offline:
        rows = load_offline_fixture(args.offline)
        print(f"[fin] offline fixture: {len(rows)} kayit")
    elif args.tickers:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        rows = fetch_mynet(tickers, periods=args.periods)
        print(f"[fin] mynet fetch ({len(tickers)} ticker): {len(rows)} kayit")
    else:
        print("[fin] hata: --offline veya --tickers vermelisin", file=sys.stderr)
        return 2

    summary = ingest(rows, dry_run=args.dry_run)
    print(f"[fin] sonuc: {json.dumps(summary, ensure_ascii=False)}")

    if not args.dry_run and summary["upserted"] > 0:
        _state.update("financials", last_run=datetime.now(timezone.utc).isoformat())
        _state.bump_total("financials", summary["upserted"])

    return 0


if __name__ == "__main__":
    sys.exit(main())
