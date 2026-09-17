"""CORE API (core.ac.uk) uzerinden acik erisimli literaturu cekip
rag/psychology_sources/core/ altina .txt dosyalar olarak yazan fetch worker.

Bu betik SADECE INDIRME yapar - chunk/embed/upsert ETMEZ. Indirdikten sonra
mevcut ingest adimini calistirmalisin (rglob recursive oldugu icin core/
alt klasorunu de otomatik tarar):
    python -m rag.ingest.psychology rag/psychology_sources

DIKKAT - KALICILIK: bu betigin yazdigi klasor Docker'da imajin ICINDE
kaliyor. Hedef klasor bir volume'a baglanmazsa indirilen her sey bir
sonraki `compose up` ile siliniyor, ustelik ingest worker ile uygulama
container'i AYRI dosya sistemleri gordugu icin biri indirse digeri bos
goruyor. docker-compose.yml'de psych_sources_data volume'u tam olarak
bunun icin iki servise birden bagli - yeni bir ortam kurarken atlanmamali.

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

NOT: istek/yanit semasi artik CANLI DOGRULANDI. q parametresi, results
dizisi ve offset/limit sayfalama dogru calisiyor; _parse_response gercek
yanitla uyumlu. Dil filtresi ise YANLISTI (language.name -> language.code)
ve tirnakli ifadeler CORE tarafindan reddediliyor; ayrinti DEFAULT_QUERY
uzerindeki notta. Sorguyu degistirirken once --dry-run ile dogrula: hatali
sozdizimi 400 degil 500 donduruyor, yani "sunucu arizasi" gibi gorunuyor.
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
# Bu uzunlugun altindaki kayitlar atlanir.
#
# VARSAYILAN DUSUK: CORE cogu kayit icin fulltext degil SADECE OZET
# donduruyor ve Turkce ozetler siklikla 800-2000 karakter. 200 esigi
# bunlarin hepsini iceri aliyor - corpus buyuyor ama "psikoloji tarihi"
# turu bir ozetin klinik degeri yok, ustelik TOP_K=4 oldugu icin boyle bir
# chunk benzerlik yarisini kazanip ise yarar bir kaydin yerini alabiliyor.
# Corpus kalitesini yukseltmek icin CORE_FETCH_MIN_CHARS=1500 gibi bir
# deger deneyin; bedeli daha az ama daha dolu kayit.
MIN_TEXT_CHARS = int(os.environ.get("CORE_FETCH_MIN_CHARS", "200"))

# Tek bir kaydin corpus'ta kaplayabilecegi ust sinir.
#
# CORE cogu tez icin TAM METIN donduruyor: sahada dosya basina ortalama
# ~152 bin karakter cikti ve 100 dosya 12 bin chunk uretti. Bir tezin
# yontem ve bulgular bolumleri bir terapi asistani icin bilgi tasimiyor,
# ama chunk sayisinin buyuk kismini onlar olusturuyor ve arama sonuclarini
# seyreltiyorlar. Kirpma metnin BASINI koruyor - ozet, giris ve kuramsal
# cerceve orada.
# 0 = kirpma yok.
MAX_TEXT_CHARS = int(os.environ.get("CORE_FETCH_MAX_CHARS", "60000"))

# CORE v3 SORGU SOZDIZIMI - CANLI OLCULDU, TAHMIN DEGIL.
#
# Onceki varsayilan sorgu her cagride HTTP 500 donduruyordu ve bu, psikoloji
# corpus'unun hic olusmamasinin dogrudan sebebiydi. CORE v3 arkada Azure
# Cognitive Search kullaniyor ve iki kural var:
#
#   1. TIRNAKLI IFADE YASAK. "bilişsel davranışçı" gibi bir ifade
#      "OperationNotAllowed - ... is not a searchable field" hatasi veriyor.
#      Terimler tek tek, tirnaksiz ve OR ile baglanmali.
#   2. DIL ALANININ ADI language.code, language.name DEGIL. Ikincisi
#      "InvalidName" hatasi veriyor.
#
# Ayrica CORE Turkce diyakritikleri KATLAMIYOR: "kaygi" ile "kaygı" farkli
# sonuc kumeleri getiriyor (aksansiz 3629, aksanli 6213 kayit) ve aksanli
# form klinik olarak belirgin sekilde daha alakali basliklar donduruyor.
# O yuzden her iki yazim da listede - birlesimi aliyoruz (6226 kayit).
#
# Yeniden olcmek icin: rag/ingest/core_fetch.py --query "..." --dry-run
DEFAULT_QUERY = (
    "(psikoterapi OR psikoloji OR terapi OR anksiyete OR depresyon OR "
    "kaygı OR kaygi OR travma OR bilişsel OR bilissel OR davranışçı OR "
    "davranisci OR psikiyatri) AND language.code:tr"
)

LANG_FILTER = os.environ.get("CORE_FETCH_LANG", "language.code:tr")

# KONU LISTESI - tek genis sorgu yerine hedefli cekimler.
#
# NEDEN: tek bir genis sorgu, CORE'un alaka siralamasina gore ilk N kaydi
# getiriyor ve bu kayitlar birkac konuya yigiliyor. Danisanin "panik atak
# geciriyorum" ile "yakinimi kaybettim" sorularinin ikisine de karsilik
# verebilmek icin corpus'un konu konu beslenmesi gerekiyor.
#
# SORGULAR ELLE AYARLI, SABLONDAN URETILMIYOR - olculdu:
# ikinci bir AND grubu (terapi/mudahale/tedavi) GENEL terimlerde isabeti
# muazzam artiriyor ("farkındalık OR kabul" 11748 kayit ve ragbi
# oyuncularini getirirken, mudahale grubu eklenince 355 kayda iniyor ve
# basliklar "Bilincli Farkindalik Temelli Bilissel Terapi Programi" gibi
# oluyor). Ama zaten spesifik terimlerde ayni ek hacmi kesiyor ve konuyu
# dagitiyor (uyku 606 -> 166, sonuclar uyku apnesi ve kupa terapisine
# kayiyor). O yuzden her konu kendi sorgusunu tasiyor.
#
# TIRNAKLI IFADE YOK, COK KELIMELI TERIM DE YOK. CORE tirnaga izin
# vermiyor (OperationNotAllowed) ve tirnaksiz "kendine zarar" gibi bir
# terim beklenmedik sekilde ayrisip sorguyu genisletiyor. Her terim TEK
# KELIME olmali; ayrisma riskini bastan kaldiriyor.
#
# Yeni konu eklerken once olc:
#   python -m rag.ingest.core_fetch --query "<sorgu>" --limit 5 --dry-run
_INTERV = "(terapi OR psikoterapi OR müdahale OR tedavi OR program)"
DEFAULT_TOPICS = [
    # Spesifik terimler: ek grup gerekmiyor.
    "(anksiyete OR kaygı OR panik OR agorafobi)",
    "(travma OR TSSB OR istismar OR ayrışma)",
    "(uykusuzluk OR insomnia OR uyku)",
    "(obsesif OR kompulsif OR OKB)",
    "(sosyal OR utangaçlık OR çekingen) AND (kaygı OR fobi)",
    "(yas OR matem OR kayıp) AND (danışmanlık OR " + _INTERV.strip("()") + ")",
    "(öfke OR saldırganlık) AND (kontrol OR düzenleme OR " + _INTERV.strip("()") + ")",
    "(intihar OR özkıyım) AND (önleme OR risk OR değerlendirme)",
    "(madde OR bağımlılık OR alkol) AND " + _INTERV,
    "(yeme OR anoreksiya OR bulimia) AND " + _INTERV,
    "(ergen OR çocuk) AND (psikopatoloji OR psikiyatri OR psikoterapi)",
    "(çift OR evlilik OR ilişki) AND (çatışma OR " + _INTERV.strip("()") + ")",
    # Genel terimler: ek grup SART, yoksa alakasiz alanlara yayiliyor.
    "(depresyon OR depresif OR duygudurum) AND " + _INTERV,
    "(farkındalık OR mindfulness OR şefkat) AND " + _INTERV,
    "(bilişsel OR davranışçı) AND " + _INTERV,
    "(duygu OR emosyon) AND (düzenleme OR regülasyon) AND " + _INTERV,
    "(stres OR tükenmişlik) AND " + _INTERV,
    "(benlik OR özsaygı OR özgüven) AND " + _INTERV,
]


def _topics_from_env() -> Optional[list]:
    """CORE_FETCH_TOPICS: satir ya da ';' ile ayrilmis sorgular."""
    raw = os.environ.get("CORE_FETCH_TOPICS", "").strip()
    if not raw:
        return None
    parts = [t.strip() for chunk in raw.split("\n") for t in chunk.split(";")]
    return [t for t in parts if t] or None


def _headers() -> dict:
    return {"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}


# CORE ARA SIRA 500 DONUYOR VE BU GECICI.
#
# Olculdu: ayni sorgu ust uste ucunde 200 donerken bir baskasinda
# {"message": "Idle timeout reached for ...search.windows.net..."} ile 500
# donebiliyor - arkadaki Azure Search bazen yetismiyore. Yani 500 burada
# "istek hatali" DEGIL, "tekrar dene" demek.
#
# Tekrar denemesiz hali bu boru hattini kumar haline getiriyordu: tek bir
# gecici 500, butun psikoloji fetch'ini iptal ediyor, bootstrap
# "core failed" yazip geciyor ve corpus bir sonraki gune kadar bos kaliyor.
CORE_RETRIES = int(os.environ.get("CORE_FETCH_RETRIES", "4"))
CORE_RETRY_BACKOFF_SEC = float(os.environ.get("CORE_FETCH_RETRY_BACKOFF_SEC", "5"))


def _error_message(resp) -> str:
    """Yanit govdesinden okunabilir hata metnini cikarir.

    NEDEN: eskiden yalnizca raise_for_status()'un tek satiri loglaniyordu
    ("500 Server Error ... for url: ...") ve bu, GECICI bir zaman asimi ile
    HATALI SORGU sozdizimini ayirt edilemez kiliyordu. Ikisi de 500 donuyor;
    fark sadece govdede. Bu yuzden language.name hatasi uzun sure
    "CORE bozuk" sanildi.
    """
    try:
        data = resp.json() or {}
        msg = data.get("message") or data.get("error") or ""
        if msg:
            return str(msg)[:200]
    except Exception:
        pass
    return (resp.text or "")[:200]


def search(query: str, *, offset: int, limit: int) -> dict[str, Any]:
    """CORE v3 /search/works cagrisi. Gecici hatalarda tekrar dener."""
    last_detail = ""
    for attempt in range(1, CORE_RETRIES + 1):
        try:
            resp = requests.get(
                f"{API_BASE_URL}/search/works",
                params={"q": query, "offset": offset, "limit": limit},
                headers=_headers(),
                timeout=HTTP_TIMEOUT,
            )
        except requests.RequestException as e:
            last_detail = f"baglanti: {str(e)[:150]}"
        else:
            # Bunlar tekrar denemekle duzelmez - hemen bildir.
            if resp.status_code == 401:
                raise RuntimeError("CORE API 401 Unauthorized - CORE_API_KEY eksik/gecersiz.")
            if resp.status_code == 429:
                raise RuntimeError(
                    "CORE API 429 Too Many Requests - CORE_FETCH_DELAY_SEC'i artir."
                )
            if resp.status_code < 400:
                return resp.json()

            last_detail = f"HTTP {resp.status_code}: {_error_message(resp)}"
            # 4xx (429 haric) bizim sorgumuzun hatasi; tekrar denemek bosuna.
            if 400 <= resp.status_code < 500:
                raise RuntimeError(f"CORE API {last_detail}")

        if attempt < CORE_RETRIES:
            wait = CORE_RETRY_BACKOFF_SEC * attempt
            print(f"[core_fetch] {last_detail} (deneme {attempt}/{CORE_RETRIES}); "
                  f"{wait:.0f}s sonra tekrar.")
            time.sleep(wait)

    raise RuntimeError(f"CORE API {CORE_RETRIES} denemede basarisiz - {last_detail}")


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
    if MAX_TEXT_CHARS > 0 and len(body) > MAX_TEXT_CHARS:
        body = body[:MAX_TEXT_CHARS]
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


def _with_lang(query: str) -> str:
    """Konu sorgusuna dil filtresini ekler (zaten varsa dokunmaz)."""
    if not LANG_FILTER or LANG_FILTER in query:
        return query
    return f"{query} AND {LANG_FILTER}"


def main(argv: Optional[list] = None) -> int:
    p = argparse.ArgumentParser(description="CORE API'den (core.ac.uk) psikoloji literaturu cek")
    p.add_argument("--query", type=str, default=None,
                   help="Tek bir CORE arama sorgusu. Verilmezse konu listesi dolasilir.")
    p.add_argument("--topics", action="store_true",
                   help="Konu listesini acikca kullan (--query verilmediginde zaten varsayilan)")
    p.add_argument("--limit", type=int, default=50,
                   help="KONU BASINA en fazla kac makale cekilsin")
    p.add_argument("--dry-run", action="store_true", help="Dosya yazma, sadece raporla")
    args = p.parse_args(argv)

    if args.query and not args.topics:
        queries = [args.query]
    else:
        queries = _topics_from_env() or DEFAULT_TOPICS

    total = {"fetched": 0, "written": 0, "skipped_duplicate": 0, "skipped_short": 0}
    failed = 0
    for idx, q in enumerate(queries, 1):
        full = _with_lang(q)
        label = q if len(q) <= 64 else q[:61] + "..."
        print(f"[core_fetch] konu {idx}/{len(queries)}: {label}")
        try:
            summary = fetch(full, limit=args.limit, dry_run=args.dry_run)
        except Exception as e:
            # TEK KONUNUN HATASI BUTUN CEKIMI IPTAL ETMEMELI. Bir konu
            # sorgusu CORE tarafindan reddedilirse ya da tekrar denemeler
            # tukenirse digerleri yine de calissin; aksi halde tek bir
            # aksilik corpus'un tamamini gunceltmeden birakiyor.
            failed += 1
            print(f"[core_fetch] konu basarisiz ({label}): {e}", file=sys.stderr)
            continue
        for k in total:
            total[k] += summary.get(k, 0)
        print(f"[core_fetch]   -> {summary}")

    total["topics"] = len(queries)
    total["failed_topics"] = failed
    total["dry_run"] = args.dry_run
    print(f"[core_fetch] sonuc: {total}")
    if failed:
        print(f"[core_fetch] UYARI: {failed}/{len(queries)} konu cekilemedi.", file=sys.stderr)
    if not args.dry_run and total["written"] > 0:
        print(f"[core_fetch] Simdi calistir: python -m rag.ingest.psychology {DEST_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
