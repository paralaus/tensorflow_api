#!/usr/bin/env python3
"""AI Psikolog RAG zincirinin nerede koptugunu tek komutta gosterir.

    python -m scripts.rag_psych_doctor
    (ya da: venv/bin/python scripts/rag_psych_doctor.py)

NEDEN VAR: bu zincirin HER katmani sessizce bozuluyor. Embedder saglayicisi
cevap vermezse embed_query None doner, psych_retriever.retrieve() de None
doner, /psychology/chat ise context'i hic eklemeden devam eder. Sonuc: model
literatur olmadan cevap verir ve hicbir yerde hata gorunmez - "RAG kapali"
ile "RAG alakali bir sey bulamadi" disaridan birebir ayni gorunur.

Betik hicbir sey yazmaz/degistirmez; sadece okur ve rapor eder.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

OK, WARN, FAIL = "  OK  ", " UYARI", " HATA "
_verdicts: list[tuple[str, str]] = []


def say(status: str, line: str) -> None:
    print(f"[{status}] {line}")
    _verdicts.append((status, line))


def section(title: str) -> None:
    print("\n" + title)
    print("-" * len(title))


def main() -> int:
    # .env'i systemd disinda calistirildiginda da yukle - EnvironmentFile
    # yalnizca servis icin gecerli, elle calistirmada ortam bos gelir.
    env_path = ROOT / ".env"
    if env_path.exists():
        for raw in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

    section("1. KAYNAK DOSYALAR (indirilen dokumanlar)")
    sources = ROOT / "rag" / "psychology_sources"
    supported = {".pdf", ".docx", ".txt", ".md"}
    files = [p for p in sources.rglob("*") if p.is_file() and p.suffix.lower() in supported] \
        if sources.exists() else []
    print(f"     klasor: {sources}")
    if not sources.exists():
        say(FAIL, "psychology_sources klasoru YOK - ingest okuyacak bir sey bulamaz.")
    elif not files:
        say(FAIL, "psychology_sources BOS - indirme adimi (core_fetch) hic calismamis "
                  "ya da dokumanlar baska bir klasore konmus.")
    else:
        by_ext: dict[str, int] = {}
        for p in files:
            by_ext[p.suffix.lower()] = by_ext.get(p.suffix.lower(), 0) + 1
        say(OK, f"{len(files)} dosya bulundu ({', '.join(f'{k}:{v}' for k, v in sorted(by_ext.items()))})")

    # Yaygin yanlis yerlestirme: dokumanlar docs/ altina konuyor ama ingest
    # oraya HIC bakmiyor.
    docs_dir = ROOT / "docs"
    if docs_dir.exists():
        stray = [p for p in docs_dir.rglob("*")
                 if p.is_file() and p.suffix.lower() in {".pdf", ".docx"}]
        if stray:
            say(WARN, f"docs/ altinda {len(stray)} adet pdf/docx var ama ingest ORAYA BAKMIYOR. "
                      f"Indekslenmesi icin {sources} altina tasinmali.")

    section("2. EMBEDDER (metni vektore ceviren katman)")
    try:
        from rag import embedder
    except Exception as e:
        say(FAIL, f"rag.embedder import edilemedi: {e}")
        return _summary()
    print(f"     saglayici: {embedder.PROVIDER}")
    print(f"     model    : {embedder.MODEL_NAME}")
    if embedder.PROVIDER == "digitalocean":
        print(f"     endpoint : {embedder.DO_BASE_URL}")
        print(f"     query timeout: {embedder.DO_QUERY_TIMEOUT}s")
    vec = embedder.embed_query("kaygi bozuklugu belirtileri nelerdir")
    if vec:
        say(OK, f"embed_query calisti (boyut={len(vec)})")
    else:
        say(FAIL, "embed_query None dondu - RAG sorgu aninda HICBIR SEY bulamaz. "
                  "Saglayici ('" + embedder.PROVIDER + "') cevap vermiyor. "
                  "Yukaridaki '[rag/embedder] ... init hata' satiri sebebi "
                  "gosteriyor (402 = kota/yetki, timeout = ag).")

    section("3. VEKTOR VERITABANI (Chroma)")
    try:
        from rag import vectorstore as vs
    except Exception as e:
        say(FAIL, f"rag.vectorstore import edilemedi: {e}")
        return _summary()
    st = vs.stats()
    print(f"     backend: {st.get('backend')}")
    print(f"     dizin  : {st.get('dir')}")
    cols = st.get("collections") or {}
    if not cols:
        print("     koleksiyon: (yok)")
    for name, count in sorted(cols.items()):
        print(f"     koleksiyon '{name}': {count} kayit")
    psych_count = cols.get("psychology", 0)
    if st.get("backend") != "chromadb":
        say(FAIL, "Chroma devre disi (chromadb kurulu degil ya da init hatasi).")
    elif psych_count <= 0:
        say(FAIL, "'psychology' koleksiyonu BOS - ingest hic calismamis. "
                  "Calistir: python -m rag.ingest.psychology rag/psychology_sources")
    else:
        say(OK, f"'psychology' koleksiyonunda {psych_count} chunk var.")
        if files:
            print(f"     (kaba oran: dosya basina ~{psych_count / max(1, len(files)):.1f} chunk)")

    section("4. UCTAN UCA SORGU")
    try:
        from rag import psych_retriever as pr
    except Exception as e:
        say(FAIL, f"rag.psych_retriever import edilemedi: {e}")
        return _summary()
    print(f"     top_k={pr.TOP_K}  min_similarity={pr.MIN_RELEVANCE_SIMILARITY}  "
          f"max_ctx={pr.MAX_CONTEXT_CHARS}")
    probe = "Surekli kaygi hissediyorum ve uykuya dalmakta zorlaniyorum"
    ctx = None
    try:
        ctx = pr.retrieve(probe)
    except Exception as e:
        say(FAIL, f"retrieve() hata firlatti: {e}")
    print(f"     ornek soru: {probe!r}")
    if ctx:
        say(OK, f"context dondu ({len(ctx)} karakter) - zincir ucdan uca calisiyor.")
        print("     --- donen context (ilk 400 karakter) ---")
        print("     " + ctx[:400].replace("\n", "\n     "))
    else:
        say(FAIL, "retrieve() None dondu - model bu soruda literaturu KULLANMIYOR. "
                  "Yukaridaki adimlardan ilk HATA satiri sebebi gosteriyor.")

    return _summary()


def _summary() -> int:
    section("SONUC")
    fails = [l for s, l in _verdicts if s == FAIL]
    warns = [l for s, l in _verdicts if s == WARN]
    if not fails:
        print("RAG zinciri calisiyor.")
    else:
        print(f"{len(fails)} kritik sorun:")
        for l in fails:
            print(f"  - {l}")
    if warns:
        print(f"{len(warns)} uyari:")
        for l in warns:
            print(f"  - {l}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
