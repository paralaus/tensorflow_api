# mediasoup Worker Hatalari (`code:40`)

Droplet loglarinda su hatalari goruyorsaniz bu dokuman icindir:

```
hissechat-ai-service | Failed to init conference socket: Error: [pid:34, code:40, signal:null]
hissechat-ai-service |     at ChildProcess.<anonymous> (/app/node_modules/mediasoup/node/lib/Worker.js:145:43)
hissechat-ai-service | [Server] Isleyici yaratma HATASI ---> Error: [pid:36, code:40, signal:null]
```

## Hata ne anlama geliyor?

mediasoup, SFU'yu `mediasoup-worker` adli ayri bir native process olarak
calistirir. Bu process ayaga kalkmadan olurse Node tarafi sadece
`[pid, code, signal]` ucluusunu gosterir. Cikis kodlari mediasoup worker
kaynagindan gelir (`worker/src/lib.cpp`, `worker/src/main.cpp`):

| Kod | Anlami |
| --- | --- |
| 40 | "unknown error" - worker init/run sirasinda C++ exception firladi |
| 41 | `MEDIASOUP_VERSION` env yok (binary mediasoup kutuphanesi disindan calistirilmis) |
| 42 | "settings error" - `--rtcMinPort` / `--logLevel` gibi argumanlar gecersiz |

Yani **40 bir ayar hatasi degildir** (o 42 olurdu); worker baslangicta patliyor.

Gercek sebep worker'in kendi stderr satirinda yazar, ama mediasoup bunu `debug`
modulune (`mediasoup:ERROR:Worker`) yonlendirir ve `DEBUG` set degilse hicbir
yere basilmaz. Bu yuzden logda sadece `code:40` gorunur.

## En olasi sebep: Docker + io_uring

mediasoup worker, **calisan kernel 6 veya ustuyse** liburing/io_uring yolunu
acar (`DepLibUring::ClassInit`). Docker'in varsayilan seccomp profili
`io_uring_setup` cagrisini engeller, bu yuzden `io_uring_queue_init()` EPERM
ile doner, worker exception firlatir ve **40 ile cikar**. Guncel Droplet'ler
kernel 6.x ile geldigi icin bu kombinasyon container icinde her zaman patlar.

Dikkat: mediasoup'un hazir (prebuilt) worker binary'leri liburing **ile**
derlenmistir. Yani prebuilt indirilirse sorun geri gelir.

### Cozum 1 (tercih edilen): worker'i liburing olmadan derle

`Dockerfile` bunu zaten yapiyor:

```dockerfile
ENV MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true
ENV MESON_ARGS="-Dms_disable_liburing=true"
COPY package.json .
RUN npm install
```

Image bu satirlardan once build edildiyse ya da katman cache'i eski binary'yi
tasiyorsa hata devam eder. Temiz build alin:

```bash
docker build --no-cache -t hissechat-ai-service .
```

Build sirasinda su satiri gormelisiniz:

```
mediasoup-worker built without liburing: OK
```

Gormuyorsaniz build zaten hata verir: `Dockerfile` binary icinde liburing izi
ararsa build'i durdurur, boylece bozuk image droplet'te crash-loop'a girmez.

### Cozum 2: container'a io_uring izni ver

Image'i yeniden derleyemiyorsaniz:

```bash
docker run --security-opt seccomp=unconfined ...
```

docker compose ile:

```yaml
services:
  hissechat-ai-service:
    security_opt:
      - seccomp:unconfined
```

Bu guvenlik acisindan daha gevsek bir secenektir; kalici cozum olarak Cozum 1
tercih edilmelidir.

## Kod 40'in diger sebepleri

- OpenSSL DTLS sertifikasini uretemiyor (`DtlsTransport::ClassInit`): FIPS modu
  veya SHA1 imzalarini yasaklayan bir kripto politikasi.
- libsrtp / usrsctp init hatasi.

Her iki durumda da gercek mesaj worker stderr'inde yazar, o yuzden once asagidaki
teshis adimlarini calistirin.

## Teshis

Container icinde:

```bash
docker exec -it hissechat-ai-service node scripts/check-mediasoup-worker.js
```

Script; kernel surumunu, worker binary yolunu, binary'nin liburing ile derlenip
derlenmedigini yazar, sonra gercekten bir worker + router ayaga kaldirmayi dener
ve basarisiz olursa cikis kodunu insanca aciklar. Cikis kodu 0 = saglikli.

Uygulamanin kendi loglarinda worker stderr'ini gormek icin:

```bash
DEBUG="mediasoup*" node src/Server.js
```

`start.sh` artik `DEBUG` set degilse `mediasoup:ERROR*,mediasoup:WARN*`
degerini otomatik veriyor; yani normal calismada sessiz, hata halinde gercek
sebep container logunda gorunur. Ayrica her container acilisinda yukaridaki
preflight script'i calisir ve sorun varsa `WARNING: mediasoup worker preflight
FAILED` satirini basar.

## Port araligi notu

Konferans tarafi (`src/ConferenceSocket.js`) RTP portlarini
`MEDIASOUP_MIN_PORT`-`MEDIASOUP_MAX_PORT` (varsayilan 40000-40100) araligindan
dagitir ve bu araligi worker sayisina boler. `Dockerfile` da ayni araligi
`EXPOSE` eder. Bu araligin droplet firewall'unda **UDP ve TCP** olarak acik
olmasi gerekir; aksi halde worker'lar saglikli baslasa bile medya akmaz.
