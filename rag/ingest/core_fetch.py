"""CORE API (core.ac.uk) uzerinden acik erisimli literaturu cekip
rag/psychology_sources/core/ altina .txt dosyalar olarak yazan fetch worker.

Bu betik SADECE INDIRME yapar - chunk/embed/upsert ETMEZ. Indirdikten sonra
mevcut ingest adimini calistirmalisin (rglob recursive oldugu icin core/
alt klasorunu de otomatik tarar):
    python -m rag.ingest.psychology rag/psychology_sources

Kurulum:
    1. https://core.ac.uk/api-keys/register adresinden UCRETSIZ bir API
       anahtari al (CORE, acik erisimli akademik makaleleri agregre eden
       bir servis - anahtar almak icin sadece e-posta yeterli).
    2. CORE_API_KEY ortam degiskenini ayarla (bu betige asla sabit
       kodlanmaz - env degiskeni/.env ile saglanir).

Calisma:
    # Once dry-run ile ne cekilecegini gor (dosya yazmaz)
    python -m rag.ingest.core_fetch --query "psikoloji" --limit 20 --dry-run

    # Gercek indirme
    python -m rag.ingest.core_fetch --limit 50
    python -m rag.ingest.core_fetch --query "bilissel davranisci terapi" --limit 30

NOT: CORE v3 API'nin (api.core.ac.uk/v3) tam istek/yanit semasi bu ortamda
CANLI DOGRULANAMADI (docs.core.ac.uk/v3 sayfasi bot-engelleme nedeniyle
erisilemedi - sadece yayimlanmis alan adlari ve arama sonucu ozetlerinden
derlendi). Asagidaki istek formati (q parametresi, results dizisi,
offset/limit sayfalama, language.name:tr filtresi) CORE'un genel v3 REST
konvansiyonlarina dayaniyor ama ilk calistirmada MUTLAKA --dry-run ile
kontrol et; yanit semasi farkliysa _parse_response'u gercek yanita gore
guncelle.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from typing import Any, Optional

import requests

API_BASE_URL = os.environ.get("CORE_API_BASE_URL", "https://api.core.ac.uk/v3").rstrip("/")
API_KEY = os.environ.get("CORE_API_KEY", "").strip()
DEST_DIR = os.environ.get(
    "CORE_FETCH_DEST_DIR",
    os.path.join(os.path.dirname(__file__), "..", "psychology_sources", "core"),
)
DEST_DIR = os.path.abspath(DEST_DIR)
PAGE_SIZE = int(os.environ.get("CORE_FETCH_PAGE_SIZE", "20"))
# CORE'un dokumante edilen rate limiti dusuk (tekli aramalar icin 10sn'de
# birkac istek) - varsayilan gecikme temkinli tutuldu.
REQUEST_DELAY_SEC = float(os.environ.get("CORE_FETCH_DELAY_SEC", "2.0"))
# Gercek testte CORE'un arama sorgulari (ozellikle coklu OR terimli
# sorgular) tek sayfa icin bile 45-60sn surebiliyor - varsayilani buna
# gore comert tuttuk, aksi halde varsayilan ayarlarla her calistirma
# timeout'a takilabiliyordu.
HTTP_TIMEOUT = float(os.environ.get("CORE_FETCH_TIMEOUT", "60"))
MIN_TEXT_CHARS = 200  # ozet/fulltext bu kadardan kisaysa anlamsiz, atla

DEFAULT_QUERY = (
    '(psikoloji OR psychology OR "bilişsel davranışçı" OR "cognitive behavioral" '
    'OR "klinik psikoloji" OR "clinical psychology") AND language.name:tr'
)


def _headers() -> dict:
    return {"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}


def search(query: str, *, offset: int, limit: int) -> dict[str, Any]:
    """CORE v3 /search/works cagrisi. Hata -> exception (caller yakalar)."""
    resp = requests.get(
        f"{API_BASE_URL}/search/works",
        params={"q": query, "offset": offset, "limit": limit},
        headers=_headers(),
        timeout=HTTP_TIMEOUT,
    )
    if resp.status_code == 401:
        raise RuntimeError("CORE API 401 Unauthorized - CORE_API_KEY eksik/gecersiz.")
    if resp.status_code == 429:
        raise RuntimeError("CORE API 429 Too Many Requests - CORE_FETCH_DELAY_SEC'i artir.")
    resp.raise_for_status()
    return resp.json()


def _parse_response(data: dict[str, Any]) -> tuple[list[dict], int]:
    """CORE v3'un dokumante edilen sekli: {"totalHits": N, "results": [...]}.

    Gercek yanit farkliysa (ornegin "data" veya baska bir anahtar altinda)
    bu fonksiyonu --dry-run ciktisina gore guncelle.
    """
    results = data.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"Beklenmeyen CORE yanit semasi, ust seviye anahtarlar: {list(data.keys())}")
    total = data.get("totalHits", len(results))
    return results, total


def _slugify(text: str, max_len: int = 80) -> str:
    text = re.sub(r"[^\w\s-]", "", text or "", flags=re.UNICODE).strip().lower()
    text = re.sub(r"[\s_-]+", "-", text)
    return text[:max_len] or "makale"


def make_text(record: dict[str, Any]) -> Optional[str]:
    """Bir CORE kaydindan .txt dosyasina yazilacak metni uretir. Basligin
    yani sira, varsa TAM METNI (fullText), yoksa ozeti (abstract) kullanir -
    hicbiri yoksa ya da cok kisaysa None doner (kayit atlanir)."""
    title = (record.get("title") or "").strip()
    abstract = (record.get("abstract") or record.get("description") or "").strip()
    full_text = (record.get("fullText") or "").strip()
    authors = record.get("authors") or []
    author_names = ", ".join(
        a.get("name", "") if isinstance(a, dict) else str(a) for a in authors
    )[:300]
    year = record.get("yearPublished") or record.get("year") or ""

    body = full_text if len(full_text) > len(abstract) else abstract
    if len(body) < MIN_TEXT_CHARS:
        return None

    header_lines = [title]
    meta_line = " | ".join(x for x in [author_names, str(year)] if x)
    if meta_line:
        header_lines.append(meta_line)
    return "\n\n".join(header_lines + ["", body])


def fetch(query: str, *, limit: int, dry_run: bool = False) -> dict[str, Any]:
    if not API_KEY and not dry_run:
        raise RuntimeError(
            "CORE_API_KEY ayarli degil. https://core.ac.uk/api-keys/register adresinden "
            "ucretsiz bir anahtar alip ortam degiskenine ekle."
        )

    from rag.ingest import _state

    state = _state.load("core")
    seen_ids: set = set(state.get("seen_ids") or [])

    os.makedirs(DEST_DIR, exist_ok=True)

    summary: dict[str, Any] = {
        "fetched": 0, "written": 0, "skipped_duplicate": 0, "skipped_short": 0, "dry_run": dry_run,
    }
    offset = 0
    while summary["fetched"] < limit:
        page_size = min(PAGE_SIZE, limit - summary["fetched"])
        data = search(query, offset=offset, limit=page_size)
        results, total = _parse_response(data)
        if not results:
            break

        for record in results:
            summary["fetched"] += 1
            core_id = str(record.get("id") or record.get("coreId") or "")
            if not core_id:
                continue
            if core_id in seen_ids:
                summary["skipped_duplicate"] += 1
                continue

            text = make_text(record)
            if not text:
                summary["skipped_short"] += 1
                continue

            title = (record.get("title") or "makale").strip()
            file_name = f"{_slugify(title)}-{core_id}.txt"
            out_path = os.path.join(DEST_DIR, file_name)

            if dry_run:
                print(f"[core_fetch] dry-run: {file_name} ({len(text)} karakter)")
            else:
                with open(out_path, "w", encoding="utf-8") as f:
                    f.write(text)
                seen_ids.add(core_id)
                summary["written"] += 1

        offset += page_size
        if offset >= total:
            break
        time.sleep(REQUEST_DELAY_SEC)

    if not dry_run and summary["written"] > 0:
        _state.update("core", seen_ids=list(seen_ids))
        _state.bump_total("core", summary["written"])

    return summary


def main(argv: Optional[list] = None) -> int:
    p = argparse.ArgumentParser(description="CORE API'den (core.ac.uk) psikoloji literaturu cek")
    p.add_argument("--query", type=str, default=DEFAULT_QUERY, help="CORE arama sorgusu")
    p.add_argument("--limit", type=int, default=50, help="En fazla kac makale cekilsin")
    p.add_argument("--dry-run", action="store_true", help="Dosya yazma, sadece raporla")
    args = p.parse_args(argv)

    try:
        summary = fetch(args.query, limit=args.limit, dry_run=args.dry_run)
    except Exception as e:
        print(f"[core_fetch] hata: {e}", file=sys.stderr)
        return 1

    print(f"[core_fetch] sonuc: {summary}")
    if not args.dry_run and summary["written"] > 0:
        print(f"[core_fetch] Simdi calistir: python -m rag.ingest.psychology {DEST_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
