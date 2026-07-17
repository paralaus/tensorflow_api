"""Psikoloji literatur ingest worker.

kap.py/financials.py'nin aksine LIVE bir API kaynagi yok: musteri/ekip
PDF/DOCX/TXT/MD dosyalarini bir klasore koyar, bu script onlari parcalayip
embed eder ve "psychology" collection'ina yukler (rag/psych_retriever.py
bu collection'i okur).

Calisma:
    # Once ne yuklenecegini gor (embed/upsert yapmaz)
    python -m rag.ingest.psychology rag/psychology_sources --dry-run

    # Gercek yukleme
    python -m rag.ingest.psychology rag/psychology_sources

Idempotent: her chunk'in id'si dosya yolu + chunk no + icerik hash'inden
uretilir - ayni dosyayi tekrar calistirmak yeni kayit acmaz, uzerine yazar.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from pathlib import Path
from typing import Any, Optional

COLLECTION = "psychology"
CHUNK_SIZE = int(os.environ.get("PSYCH_CHUNK_SIZE", "900"))
CHUNK_OVERLAP = int(os.environ.get("PSYCH_CHUNK_OVERLAP", "120"))
EMBED_BATCH = int(os.environ.get("PSYCH_EMBED_BATCH", "32"))
SUPPORTED_EXT = {"pdf", "docx", "txt", "md"}


# ---------------- Metin cikarma (app.py'nin ek dosyasi extractor'larinin
# ayni mantigi - Flask app'i import etmemek icin burada tekrarlaniyor) -----

def _extract_text_from_pdf(blob: bytes) -> str:
    from io import BytesIO
    from pypdf import PdfReader

    reader = PdfReader(BytesIO(blob))
    parts = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            continue
    return "\n".join(parts).strip()


def _extract_text_from_docx(blob: bytes) -> str:
    from io import BytesIO
    import docx as _docx

    document = _docx.Document(BytesIO(blob))
    return "\n".join(p.text for p in document.paragraphs).strip()


def _extract_text_from_txt(blob: bytes) -> str:
    try:
        return blob.decode("utf-8").strip()
    except UnicodeDecodeError:
        return blob.decode("utf-8", errors="ignore").strip()


def extract_text(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".")
    blob = path.read_bytes()
    if ext == "pdf":
        return _extract_text_from_pdf(blob)
    if ext == "docx":
        return _extract_text_from_docx(blob)
    return _extract_text_from_txt(blob)  # txt, md


# ---------------- Chunk ----------------

def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    text = re.sub(r"[ \t]+", " ", text or "")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
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


def discover_files(source_dir: str) -> list[Path]:
    root = Path(source_dir)
    if not root.exists():
        return []
    return sorted(
        p for p in root.rglob("*")
        if p.is_file() and p.suffix.lower().lstrip(".") in SUPPORTED_EXT
    )


def make_docs(path: Path, source_dir: str) -> list[dict[str, Any]]:
    try:
        text = extract_text(path)
    except Exception as e:
        print(f"[psych] '{path}' metin cikarilamadi: {e}", file=sys.stderr)
        return []
    if not text:
        print(f"[psych] '{path}' bos/okunamadi, atlandi.", file=sys.stderr)
        return []

    rel = str(path.relative_to(source_dir)).replace("\\", "/")
    title = path.stem
    parts = chunk_text(text)
    file_hash = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:10]
    out: list[dict[str, Any]] = []
    for i, part in enumerate(parts):
        h = hashlib.sha1(part.encode("utf-8")).hexdigest()[:8]
        cid = f"psych-{file_hash}-{i}-{h}"
        meta = {
            "source": "psychology",
            "title": title[:160],
            "file": rel[:200],
            "chunk_index": i,
        }
        out.append({"id": cid, "document": part, "metadata": meta})
    return out


# ---------------- Run ----------------

def ingest(source_dir: str, *, dry_run: bool = False) -> dict[str, Any]:
    files = discover_files(source_dir)
    summary: dict[str, Any] = {"files": len(files), "chunks": 0, "upserted": 0, "dry_run": dry_run}

    docs: list[dict[str, Any]] = []
    for f in files:
        docs.extend(make_docs(f, source_dir))
    summary["chunks"] = len(docs)

    if not docs:
        return summary

    if dry_run:
        print(f"[psych] dry-run: {len(files)} dosya, {len(docs)} chunk. Ornekler:")
        for d in docs[:3]:
            print(f"  - {d['id']}  meta={d['metadata']}")
            print(f"      {d['document'][:160]!r}")
        return summary

    from rag import embedder, vectorstore as vs

    if not embedder.is_ready():
        embedder._ensure_loaded()  # type: ignore[attr-defined]
    if not embedder.is_ready():
        print("[psych] embedder hazir degil, upsert iptal.", file=sys.stderr)
        return summary
    if not vs.is_ready():
        print("[psych] vectorstore hazir degil, upsert iptal.", file=sys.stderr)
        return summary

    ok_count = 0
    for i in range(0, len(docs), EMBED_BATCH):
        batch = docs[i : i + EMBED_BATCH]
        embs = embedder.embed_batch([d["document"] for d in batch], batch_size=EMBED_BATCH)
        if not embs or len(embs) != len(batch):
            print(f"[psych] embed_batch beklenmedik sonuc (chunk {i}-{i+len(batch)}), atlandi.", file=sys.stderr)
            continue
        ok = vs.upsert(
            COLLECTION,
            ids=[d["id"] for d in batch],
            documents=[d["document"] for d in batch],
            embeddings=embs,
            metadatas=[d["metadata"] for d in batch],
        )
        if ok:
            ok_count += len(batch)

    summary["upserted"] = ok_count
    return summary


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Psikoloji literatur ingest worker")
    p.add_argument(
        "source_dir", type=str, nargs="?", default="rag/psychology_sources",
        help="PDF/DOCX/TXT/MD dosyalarinin bulundugu klasor (default: rag/psychology_sources)",
    )
    p.add_argument("--dry-run", action="store_true", help="Embed/upsert yapma, sadece raporla")
    args = p.parse_args(argv)

    summary = ingest(args.source_dir, dry_run=args.dry_run)
    print(f"[psych] sonuc: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
