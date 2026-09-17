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

# Anlamsiz chunk'lari indekse hic sokmamak icin esikler.
#
# NEDEN GEREKLI: CORE bircok kayit icin tam metin donduruyor, yani 300
# sayfalik tezler de corpus'a giriyor. Bir tezin govdesi kadar EKLERI de
# indeksleniyordu: Beck Depresyon Olcegi maddeleri, kaynakca listeleri,
# tablo doküntüleri, icindekiler. Bunlar konu kelimeleri tasidigi icin
# benzerlik yarisini KAZANIYOR ama bilgi tasimiyor.
#
# Sahada goruldu: "surekli kaygi hissediyorum" sorusuna donen context,
# bir tezin ekindeki olcek maddeleriydi ("0 Dis gorunusumun eskisinden
# daha kotu oldugunu sanmiyorum  1 Yaslandigimi ve cekiciligimi
# kaybettigimi dusunuyorum ..."). Boyle bir metni modele baglam diye
# vermek hicbir sey vermemekten kotu: model zor durumdaki kullaniciya
# olcek maddesi tekrarlayabilir.
CHUNK_MIN_CHARS = int(os.environ.get("PSYCH_CHUNK_MIN_CHARS", "300"))
# Rakam yogunlugu: olcek maddeleri ve tablolar rakamla dolu, duz metin degil.
CHUNK_MAX_DIGIT_RATIO = float(os.environ.get("PSYCH_CHUNK_MAX_DIGIT_RATIO", "0.12"))
# Kelime cesitliligi: icindekiler/kaynakca ayni kaliplari tekrarlar.
CHUNK_MIN_UNIQUE_WORD_RATIO = float(os.environ.get("PSYCH_CHUNK_MIN_UNIQUE_RATIO", "0.45"))
# Bir chunk icinde bu kadar cok "satir basi rakam" varsa madde listesidir.
CHUNK_MAX_NUMBERED_LINES = int(os.environ.get("PSYCH_CHUNK_MAX_NUMBERED_LINES", "4"))
# Tek basina duran kucuk sayilarin ust siniri.
#
# Likert/olcek maddelerinin parmak izi bu: "0 Kendimi uzgun hissetmiyorum
# 1 Kendimi uzgun hissediyorum 2 ... 3 ...". Rakam YOGUNLUGU (karakter
# orani) bunu yakalamiyor, cunku maddelerin metni uzun - bir tez ekindeki
# olcek sayfasi karakterlerin yalnizca %2'si rakam oldugu halde bilgi
# tasimiyor. Ayirt edici olan, tek basina duran sayilarin SAYISI.
#
# Esik 6: normal klinik metin de sayi kullaniyor ("240 katilimci",
# "12 haftalik program", "3 olcum") ama bir chunk'ta nadiren altidan
# fazlasi oluyor; olcek maddelerinde her madde en az dort tane getiriyor.
CHUNK_MAX_BARE_NUMBERS = int(os.environ.get("PSYCH_CHUNK_MAX_BARE_NUMBERS", "6"))

# Kaynakca satirlarinin parmak izi: yil parantezi, sayfa araligi, doi.
_REFERENCE_RE = re.compile(r"\(\d{4}\)|\bdoi\s*:|\bss?\.\s*\d+\s*-\s*\d+", re.IGNORECASE)


def looks_like_noise(chunk: str) -> bool:
    """Bilgi tasimayan chunk'lari (olcek maddesi, kaynakca, tablo) eler."""
    text = (chunk or "").strip()
    if len(text) < CHUNK_MIN_CHARS:
        return True

    digits = sum(1 for c in text if c.isdigit())
    if digits / len(text) > CHUNK_MAX_DIGIT_RATIO:
        return True

    words = re.findall(r"[^\W\d_]{2,}", text, flags=re.UNICODE)
    if len(words) < 20:
        return True
    lowered = [w.lower() for w in words]
    if len(set(lowered)) / len(lowered) < CHUNK_MIN_UNIQUE_WORD_RATIO:
        return True

    # Madde listeleri. Sayinin ardindan NOKTA/PARANTEZ SART ve satir basinda
    # olmali: aksi halde "3 hafta icinde", "5 seans sonra" gibi normal klinik
    # ifadeler madde sanilip gercek metin eleniyordu.
    numbered = len(re.findall(r"(?:^|\n)\s*\d{1,2}[\.\)]\s*[^\W\d_]", text,
                              flags=re.UNICODE | re.MULTILINE))
    if numbered > CHUNK_MAX_NUMBERED_LINES:
        return True

    # Olcek/Likert maddeleri: tek basina duran kucuk sayilarin bollugu.
    bare_numbers = len(re.findall(r"(?<![^\W\d_])\b\d{1,3}\b(?![^\W\d_])", text))
    if bare_numbers > CHUNK_MAX_BARE_NUMBERS:
        return True

    # Kaynakca: cok sayida yil-parantezi / sayfa araligi / doi
    if len(_REFERENCE_RE.findall(text)) >= 3:
        return True

    return False


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Metni parcalar. Kesim noktalari CUMLE/PARAGRAF sinirina cekilir.

    Eskiden kesim ham karakter ofsetiyle yapiliyordu ve chunk'lar kelime
    ortasinda basliyordu ("kiyorum  3 Artik hic karar veremiyorum..."). Bu
    hem modele yarim cumle veriyor hem de embedding kalitesini dusuruyor:
    bas ve son parcalar anlamsiz token dizileri oluyor.
    """
    text = re.sub(r"[ \t]+", " ", text or "")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]

    chunks: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        end = min(i + size, n)
        if end < n:
            # Pencerenin son %25'inde bir cumle/paragraf sonu ara.
            window_start = i + int(size * 0.75)
            cut = max(
                text.rfind("\n\n", window_start, end),
                text.rfind(". ", window_start, end),
                text.rfind("! ", window_start, end),
                text.rfind("? ", window_start, end),
            )
            if cut == -1:
                cut = text.rfind(" ", window_start, end)  # hic degilse kelime sinirinda
            if cut > i:
                end = cut + 1
        chunk = text[i:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= n:
            break
        # Bir sonraki parca ortusme kadar GERIDEN bassin.
        #
        # DIKKAT - burada `max(i + step, ...)` YAZMAK BOSLUK URETIYOR:
        # cumle siniri arandigi icin `end` cogu zaman i+size'dan kucuk
        # oluyor ve i+step o zaman `end`'in OTESINE dusuyor. Sonuc, hem
        # ortusmenin kaybolmasi hem de aradaki metnin hic indekslenmemesi
        # - ikisi de sessiz. Pencere boyu zaten `end` icinde kodlu, o
        # yuzden tek dogru referans `end`.
        nxt = max(i + 1, end - overlap)
        space = text.rfind(" ", max(i + 1, nxt - 60), nxt)
        i = (space + 1) if space > i else nxt
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
    parts = [c for c in chunk_text(text) if not looks_like_noise(c)]
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
    failed_batches = 0
    for i in range(0, len(docs), EMBED_BATCH):
        batch = docs[i : i + EMBED_BATCH]
        try:
            embs = embedder.embed_batch([d["document"] for d in batch], batch_size=EMBED_BATCH)
        except Exception as e:
            embs = []
            print(f"[psych] embed hata (chunk {i}-{i+len(batch)}): {e}", file=sys.stderr)
        if not embs or len(embs) != len(batch):
            failed_batches += 1
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
        else:
            failed_batches += 1

    summary["upserted"] = ok_count
    summary["failed_batches"] = failed_batches

    # EKSIK INDEKSI SESSIZ BIRAKMA.
    #
    # Eskiden basarisiz batch'ler yalnizca stderr'e bir satir yaziyordu ve
    # ozet satirindaki chunks/upserted farkini kimse okumuyordu. Sahada
    # 12282 chunk'in 8128'i yazildi - yani corpus'un ucte biri eksikti ve
    # bu, "RAG calisiyor" goruntusunun altinda gizli kaldi. Eksik indeks
    # hatali indeksten daha sinsi: sorgular calisiyor, sadece bazi
    # konularda hicbir sey bulunamiyor.
    if ok_count < len(docs):
        missing = len(docs) - ok_count
        print(
            f"[psych] UYARI: {missing} chunk INDEKSLENEMEDI "
            f"({failed_batches} batch basarisiz). Corpus EKSIK. "
            f"Sebep genellikle saglayici hiz limiti; tekrar calistirmak "
            f"eksikleri tamamlar (ingest idempotent).",
            file=sys.stderr,
        )
    return summary


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Psikoloji literatur ingest worker")
    p.add_argument(
        "source_dir", type=str, nargs="?", default="rag/psychology_sources",
        help="PDF/DOCX/TXT/MD dosyalarinin bulundugu klasor (default: rag/psychology_sources)",
    )
    p.add_argument("--dry-run", action="store_true", help="Embed/upsert yapma, sadece raporla")
    p.add_argument(
        "--reset", action="store_true",
        help=(
            "Once 'psychology' koleksiyonunu tamamen sil, sonra yeniden kur. "
            "Embedding modeli/saglayicisi degistiginde ZORUNLU: Chroma bir "
            "koleksiyonun vektor boyutunu sonradan degistiremiyor, eski "
            "vektorler yeni sorgularla uyusmaz ve arama sessizce bos doner."
        ),
    )
    args = p.parse_args(argv)

    if args.reset:
        if args.dry_run:
            print("[psych] --reset ile --dry-run birlikte kullanilamaz.")
            return 2
        from rag import vectorstore as _vs
        # Koleksiyon hic yoksa da sorun degil; drop_collection False doner.
        _vs.drop_collection(COLLECTION)

    summary = ingest(args.source_dir, dry_run=args.dry_run)
    print(f"[psych] sonuc: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
