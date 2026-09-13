# AI Psikolog Avatarı — Viseme Protokolü

Görüntülü görüşmede AI Psikolog'un konuşan yüzü **client tarafında** üretilir.
Sunucu video encode etmez; sadece "hangi anda hangi ağız şekli" bilgisini
gönderir.

## Neden bu mimari

Alternatif, sunucuda Wav2Lip / SadTalker / MuseTalk gibi bir üretken modelle
gerçek video üretmekti. Ölçüp elediğimiz nedenler:

| | Sunucuda üretken model | Client'ta avatar (seçilen) |
|---|---|---|
| Eşzamanlı 10 görüşme | ~10 GPU (model oturum başına GPU'yu doldurur) | 0 ek maliyet |
| Tur gecikmesi | ASR+LLM+TTS üstüne **+video üretimi** | +0 |
| Downlink | +300kbps–1Mbps/kullanıcı (mobil veri) | ~0 |
| Dudak senkronu | Bedava (aynı pacing) | ±100ms hizalama işi var |
| Foto-gerçekçilik | Yüksek | Stilize |

Belirleyici olan maliyet eğrisi: sunucu tarafı çözüm eşzamanlı görüşme
sayısıyla doğrusal GPU ister. Client tarafı kullanıcının zaten boşta duran
telefon GPU'sunu kullanır, marjinal maliyeti sıfırdır. Ayrıca bir AI terapist
için foto-gerçekçi insan yüzü, kırılgan durumdaki kullanıcının karşısındakini
insan sanması riskini taşır — stilize avatar hem klinik hem düzenleyici
(KVKK, AB AI Act şeffaflık yükümlülükleri) açıdan daha savunulabilir.

GPU'ya geçildiğinde bütçe buraya değil, gerçek darboğaza harcanmalı: seri
çalışan ASR → LLM → TTS zinciri (faster-whisper + streaming TTS).

## Parçalar

| Dosya | İş |
|---|---|
| `src/visemes.js` | PCM16 sesten viseme zaman çizelgesi çıkarır |
| `src/AiConferencePeer.js` | Çizelgeyi ve durumu socket.io ile yayınlar |
| `scripts/test_visemes.js` | Çıkarıcının doğrulaması (`node scripts/test_visemes.js`) |
| mobile `src/types/aiAvatar.ts` | Veri sözleşmesi |
| mobile `src/hooks/useAiVisemePlayer.ts` | Çizelgeyi client saatinde oynatır |
| mobile `src/components/conference/AiAvatar.tsx` | Rive + prosedürel yedek |

## Socket olayları

İkisi de `/conference` namespace'inde, odaya yayın. **Ateşle-ve-unut:** eski
mobil sürümler bu olayları bilmediği için sessizce yok sayar — yayın geçişi
için güvenli.

### `ai:avatar-state`

```json
{
  "roomId": "oda-123",
  "userId": "ai-peer",
  "socketId": "ai-peer-<uuid>",
  "state": "listening"
}
```

`state`: `idle` | `listening` | `thinking` | `speaking`

Sunucunun iç durumlarının kaba karşılığı — `transcribing` ile `thinking`
avatar için aynı şey olduğu için ikisi de `thinking` olarak gider.
`speaking` dışına çıkmak client'a aynı zamanda "ağzı kapat" sinyali verir,
böylece çizelge kısa veya hatalı kalsa bile avatar açık ağızda takılı kalmaz.

### `ai:viseme-timeline`

```json
{
  "roomId": "oda-123",
  "userId": "ai-peer",
  "socketId": "ai-peer-<uuid>",
  "utteranceId": "<uuid>",
  "durationMs": 3480,
  "frameMs": 40,
  "visemeSet": ["sil", "MBP", "FV", "S", "E", "AA", "O", "U"],
  "visemes": [
    { "t": 0,   "v": "MBP", "i": 0.24 },
    { "t": 40,  "v": "E",   "i": 0.55 },
    { "t": 200, "v": "FV",  "i": 0.84 },
    { "t": 280, "v": "AA",  "i": 0.89 }
  ]
}
```

- `t` — utterance başından itibaren milisaniye, **artan sırada**
- `v` — ağız şekli, `visemeSet` içinden
- `i` — ağız açıklığı 0..1, **hedef** değer; yumuşak geçişi client tween eder
- Girişler kabaca run-length encode'lu: yeni giriş ancak şekil değiştiğinde
  ya da açıklık belirgin değiştiğinde yazılır

Boyut: ~3s'lik bir cümle ≈ 30 giriş ≈ 1 KB JSON. 60s'lik bir utterance
600 girişle sınırlanır (< 40 KB).

## Zamanlama ve senkron

Çizelge socket.io ile (birkaç ms) gelirken ses WebRTC ile gelir (ffmpeg
başlatma + mediasoup + client jitter buffer). Yani **çizelge sesten her zaman
önce ulaşır.** Sunucu çizelgeyi ffmpeg'i spawn etmeye hemen önce gönderir;
client farkı sabit bir gecikmeyle telafi eder:

```
useAiVisemePlayer.ts → DEFAULT_LEAD_MS = 200
```

Dudak senkronunda insan toleransı geniş (ITU-R BT.1359), o yüzden sabit bir
tahmin pratikte yeterli. **Sahada ayarlanacak ilk sayı burasıdır:** ağız sesin
gerisinde kalıyorsa düşürün, önünde gidiyorsa yükseltin.

## Viseme çıkarımının sınırları

`src/visemes.js` bir **fonem hizalayıcı (forced aligner) değil.** TTS'ten fonem
zamanlaması almadığımız için ağız şekli akustik ipuçlarından (5+3 bant enerjisi
+ RMS) tahmin edilir. Bilinen ve kabul edilen sınırlar:

- Türkçe'nin ön-yuvarlak ünlüleri **ö, ü** `E` olarak çıkar — yuvarlaklık F2'de
  ayırt edilecek kadar belirgin değil (ö F2~1600 / e F2~1900)
- **ş** ile **f** ayrımı zayıf; ikisi de "dar ağız" grubunda olduğu için görsel
  etkisi küçük
- Çok hızlı konuşmada geçiş sesleri atlanabilir

Animasyonu inandırıcı yapan şey viseme kimliğinden çok doğru **zamanlama** ve
ağız açıklığı **miktarı** — ikisi de bu yaklaşımla iyi çalışıyor.

Eşikler sentetik Türkçe formant tonlarıyla kalibre edildi; ölçülen değerler ve
marjlar `src/visemes.js` başındaki yorumda, doğrulama `scripts/test_visemes.js`
içinde.

**Yükseltme yolu:** TTS sağlayıcısı fonem zamanlaması vermeye başlarsa
`buildVisemeTimeline` yerine doğrudan o zamanlama beslenebilir. Çıktı formatı
aynı kalır, client'ta hiçbir şey değişmez.

## Rive asset sözleşmesi

Avatar iki backend ile çalışır. `.riv` dosyası yoksa **prosedürel yedek**
(saf React Native View'larıyla çizilen stilize yüz) otomatik devreye girer —
yani avatar hiçbir koşulda boş kutu olmaz. Şu an repoda `.riv` yok; yedek
aktif.

Tasarımcının üretmesi gereken dosya:

| | Değer |
|---|---|
| Asset adı | `ai_avatar.riv` |
| State machine | `AvatarStateMachine` |
| Number input `viseme` | `visemeSet` index'i, 0..7 |
| Number input `mouthOpen` | ağız açıklığı, 0..100 |
| Number input `mode` | 0 idle, 1 listening, 2 thinking, 3 speaking |

`viseme` index'leri `src/visemes.js` içindeki `VISEME_SET` ile birebir aynı
sırada olmak zorunda (mobile `types/aiAvatar.ts` aynı listeyi tutar). **Sıra
asla değiştirilmemeli, sadece sonuna ekleme yapılabilir.**

Yerleştirme (native asset, `resourceName` ile yüklenir):

- Android: `android/app/src/main/res/raw/ai_avatar.riv`
- iOS: dosyayı Xcode'da target'a ekleyin (Copy Bundle Resources)

Sonra `bun install && bundle exec pod install` (iOS) / gradle sync — Rive
native modülü derlenmeden `rive-react-native` yüklenemez ve yedek backend
devrede kalır.

## Yayın sırası

Mobil uygulama mağaza üzerinden dağıtıldığı için sunucu ile client aynı anda
güncellenmez. Güncellenmemiş sürümler viseme olayını bilmez ve AI karosunu
boş görür. Bu geçiş için eski sunucu tarafı VP8 avatar yolu duruyor:

```
AI_PEER_LEGACY_VIDEO_TRACK=1
```

Varsayılan **kapalı**. Açıkken eski VP8 video producer'ı da üretilir (viseme
olayı her iki durumda da gönderilir, yani A/B yapılabilir). Mobil benimseme
tamamlanınca bayrak ve `src/AiConferencePeer.js` içindeki ilgili bölüm
(`AVATAR_*` sabitleri, `ensureAvatarFrames`, `buildMouthFrameSequence`,
`sendTalkingVideoRtp`, `createSpeakVideoProducer`) tümüyle silinebilir.

Önerilen sıra:

1. Sunucuyu `AI_PEER_LEGACY_VIDEO_TRACK=1` ile deploy et — eski client'lar
   VP8 avatarı görmeye devam eder, yeni client'lar viseme'i kullanır
2. Mobil sürümü yayınla
3. Benimseme yeterli olunca bayrağı kaldır — `videoEnabled` titremesi ve
   utterance başına ffmpeg encode maliyeti de o an ortadan kalkar
