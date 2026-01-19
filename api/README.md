![restAPI](restAPI.png)

## Toplantı oluştur

SAI-GM Video Chat sunucusuna gönderilen 'API_KEY'i içeren bir 'HTTP isteği' ile bir toplantı oluşturun. Yanıt, istemcinize bir "iframe" içinde "gömülebilecek" bir "toplantı" URL'si içerir.

'API_KEY', 'app/src/config.js' dosyasında tanımlıdır, onu kendiniz değiştirin.

```js
api: {
    // app/api
    keySecret: 'saigmvideochatsfu_default_secret',
}
```

API'nin nasıl çağrılacağını gösteren bazı örnekler:

```bash
# js
node meetings.js
node meeting.js
node join.js

# php
php meetings.php
php meeting.php
php join.php

# python
python3 meetings.py
python3 meeting.py
python3 join.py

# bash
./meetings.sh
./meeting.sh
./join.sh
```

## Toplantı yerleştirme

Bir toplantının bir "hizmet"e veya "uygulamaya" yerleştirilmesi, "HTTP yanıtı"ndan "meeting" olarak belirtilen "src" özniteliğine sahip bir "iframe" kullanılmasını gerektirir.

```html
<iframe
    allow="camera; microphone; display-capture; fullscreen; clipboard-read; clipboard-write; autoplay"
    src="https://sfu.alchemy.com.tr/join/your_room_name"
    style="height: 100vh; width: 100vw; border: 0px;"
></iframe>
```

## Hızlı Entegrasyon

Basit bir "iframe" ile "görüntülü toplantıları" gerçekleştirin.

```html
<iframe
    allow="camera; microphone; display-capture; fullscreen; clipboard-read; clipboard-write; autoplay"
    src="https://sfu.alchemy.com.tr/newroom"
    style="height: 100vh; width: 100vw; border: 0px;"
></iframe>
```
