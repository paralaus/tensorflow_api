'use strict';

const os = require('os');

// https://api.ipify.org

function getIPv4() {
    const ifaces = os.networkInterfaces();
    for (const interfaceName in ifaces) {
        const iface = ifaces[interfaceName];
        for (const { address, family, internal } of iface) {
            if (family === 'IPv4' && !internal) {
                return address;
            }
        }
    }
    return '0.0.0.0'; // Harici IPv4 adresi bulunamazsa varsayılan 0.0.0.0'dır
}

const IPv4 = getIPv4();

const numWorkers = require('os').cpus().length;

module.exports = {
    console: {
        /*
            timeZone: IANA Zaman Dilimi Veritabanındaki zaman dilimi tanımlayıcılarına karşılık gelen Zaman Dilimi 'Avrupa/Roma' varsayılan UTC'dir
        */
        timeZone: 'UTC',
        debug: true,
        colors: true,
    },
    server: {
        listen: {
            // uygulama dinle
            ip: '0.0.0.0',
            port: process.env.PORT || 3010,
        },
        ssl: {
            // ssl/README.md
            cert: '../ssl/cert.pem',
            key: '../ssl/key.pem',
        },
        cors: {
            /* 
                origin: Belirtilen kaynaklara ['https://example.com', 'https://subdomain.example.com', 'http://localhost:3010'] veya belirtilmemişse tüm kaynaklara izin ver: Yalnızca GET ve POST yöntemlerine izin ver.
            */
            origin: '*',
            methods: ['GET', 'POST'],
        },
        recording: {
            /*
                Kayıt, Sunucu uygulamanızda/<dir> içinde belirlenen dizine kaydedilecektir. Not: Docker kullanıyorsanız: "app/rec" dizinini oluşturun, bunu docker-compose.yml dosyasında bir birim olarak yapılandırın, uygun izinlerden emin olun ve Docker kapsayıcısını başlatın.
            */
            enabled: false,
            endpoint: '', // Kaydı farklı bir sunucuya veya bulut hizmetine (http://localhost:8080) kaydetmek istiyorsanız URL'yi değiştirin, aksi takdirde olduğu gibi (boş) bırakın.
            dir: 'rec',
        },
    },
    middleware: {
        /*
            Middleware:
                - IP Whitelist: Örneğe erişim yalnızca izin verilenler listesinde belirtilen IP adresleriyle sınırlıdır. Bu özellik varsayılan olarak devredışı bırakılmıştır.
                - ...
        */
        IpWhitelist: {
            enabled: false,
            allowed: ['127.0.0.1', '::1'],
        },
    },
    api: {
        // app/api için varsayılan gizli anahtar
        keySecret: 'saigm_video_chat_sfu_default_secret',
        // Hangi uç noktalara izin verildiğini tanımlayın
        allowed: {
            meetings: false,
            meeting: true,
            join: true,
            token: false,
            slack: true,
            //...
        },
    },
    jwt: {
        /*
            JWT https://jwt.io/
            Ana bilgisayar yapılandırmaları ve kullanıcı kimlik doğrulaması için kimlik bilgilerini güvenli bir şekilde yöneterek güvenliği artırır ve süreçleri kolaylaştırır.
         */
        key: process.env.JWT_SECRET || 'saigm_video_chat_sfu_jwt_secret',
        exp: '1h',
        accessExpirationMinutes: process.env.JWT_ACCESS_EXPIRATION_MINUTES || 300000,
        refreshExpirationDays: process.env.JWT_REFRESH_EXPIRATION_DAYS || 365,
        resetPasswordExpirationMinutes: process.env.JWT_RESET_PASSWORD_EXPIRATION_MINUTES || 10,
        verifyEmailExpirationMinutes: process.env.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES || 10,
    },
    oidc: {
        /*
            OIDC, OAuth 2.0 üzerine kurulu bir kimlik doğrulama protokolü olan OpenID Connect anlamına gelir. 
            OAuth 2.0 protokolü üzerinde basit bir kimlik katmanı sağlayarak istemcilerin, bir yetkilendirme sunucusu tarafından gerçekleştirilen kimlik doğrulamaya dayalı olarak son kullanıcının kimliğini doğrulamasına olanak tanır.
            Kendi Sağlayıcınızı nasıl yapılandırabilirsiniz:
                1. https://auth0.com adresinden bir hesaba kaydolun.
                2. Özel gereksinimlerinize göre uyarlanmış yeni bir uygulama oluşturmak için https://manage.auth0.com/ adresine gidin.
            Açık kaynaklı bir çözüm arayanlar için şu adrese göz atın: https://github.com/panva/node-oidc-provider
        */
        enabled: false,
        config: {
            issuerBaseURL: 'https://server.example.com',
            baseURL: `http://localhost:${process.env.PORT ? process.env.PORT : 3010}`,
            clientSecret: 'clientSecret',
            secret: 'saigm_video_chat_sfu-oidc-secret',
            authorizationParams: {
                response_type: 'code',
                scope: 'openid profile email',
            },
            authRequired: false, // Tüm rotalar için kimlik doğrulama gerekiyorsa true olarak ayarlayın
            auth0Logout: true, // Auth0 ile oturum kapatmayı etkinleştirmek için true olarak ayarlayın
            routes: {
                callback: '/auth/callback', // Bir kullanıcının kimliği doğrulandıktan sonra uygulamanızın kimlik doğrulama sağlayıcısından gelen geri aramayı işleyeceği uç noktayı belirtir.
                login: false, // Kullanıcı girişi için uygulamanızda özel rota.
                logout: '/logout', // Uygulamanızın kullanıcı oturum kapatma isteklerini işleyeceği uç noktayı belirtir.
            },
        },
    },
    host: {
        /*
            Ana Bilgisayar Koruması (varsayılan: false)
            Ana bilgisayar güvenliğini artırmak için, ana makine korumasını etkinleştirin - kullanıcı kimlik doğrulaması yapın ve kullanıcılar dizisinde geçerli kullanıcı adları ve şifreler sağlayın veya kontrol için user_api_endpoint'i kullanarak aktif user_from_db'yi sağlayın. Ana bilgisayar korumasıyla birlikte oidc.enabled kullanıldığında, kimliği doğrulanmış kullanıcı geçerli olarak tanınacaktır.
        */
        protected: false,
        user_auth: false,
        users_from_db: false, // true ise api.token'ın da true olarak ayarlandığından emin olun.
        //users_api_endpoint: 'http://localhost:9000/api/v1/user/isAuth',
        users_api_endpoint: 'https://webrtc.alchemy.com/api/v1/user/isAuth',
        users_api_secret_key: 'mirotalkweb_default_secret',
        users: [
            {
                username: 'username',
                password: 'password',
                allowed_rooms: ['*'],
            },
            {
                username: 'username2',
                password: 'password2',
                allowed_rooms: ['room1', 'room2'],
            },
            {
                username: 'username3',
                password: 'password3',
            },
            //...
        ],
    },
    presenters: {
        list: [
            /*
                Varsayılan olarak sunum yapan kişi, kullanıcı adı ve UUID'si ile ayırt edilerek odaya katılan ilk katılımcı olarak tanımlanır. Belirlenen kullanıcı adları ayarlanarak geçerli sunum yapan kişileri ve ortak sunum yapan kişileri belirlemek için ek katmanlar eklenebilir.
            */
            'Bülent Çetin',
            'bulent.cetin@alchemy.com.tr',
        ],
        join_first: true, // Geleneksel davranış için true, sunum yapan kişilere öncelik vermek için false olarak ayarlayın
    },
    chatGPT: {
        /*
        ChatGPT
            1. https://platform.openai.com/ adresine gidin
            2. Hesap oluşturun
            3. APIKey oluşturun https://platform.openai.com/account/api-keys
        */
        enabled: false,
        basePath: 'https://api.openai.com/v1/',
        apiKey: '',
        model: 'gpt-3.5-turbo',
        max_tokens: 1000,
        temperature: 0,
    },
    videoAI: {
        /*
        HeyGen Video AI
            1. https://app.heygen.com'a gidin
            2. Hesap oluşturun
            3. APIKey'inizi oluşturun https://app.heygen.com/settings?nav=API
         */
        enabled: false,
        basePath: 'https://api.heygen.com',
        apiKey: '',
        systemLimit:
            '',
    },
    email: {
        /*
            Bildirimler veya uyarılar için e-posta ayarlarını yapılandırma
            Gmail yapılandırmasına ilişkin belgelere bakın: https://support.google.com/mail/answer/185833?hl=tr
        */
        alert: false,
        host: 'smtp.gmail.com',
        port: 587,
        username: 'bulent.cetin@alchemy.com.tr',
        password: 'Pi3AlFa1970',
        sendTo: 'bulent.cetin@alchemy.com.tr',
    },
    ngrok: {
        /* 
        Ngrok
            1. https://ngrok.com'a gidin
            2. Ücretsiz başlayın
            3. NgrokAuthToken'ınızı kopyalayın: https://dashboard.ngrok.com/get-started/your-authtoken
        */
        enabled: false,
        authToken: '',
    },
    sentry: {
        /*
        Sentry
            1. https://sentry.io/'a gidin
            2. Hesap oluşturun
            3. Kontrol panelinde Settings/Projects/YourProjectName/Client Keys (DSN) gidin
        */
        enabled: false,
        DSN: '',
        tracesSampleRate: 0.5,
    },
    slack: {
        /*
        Slack
            1. https://api.slack.com/apps/ adresine gidin
            2. Uygulamanızı oluşturun
            3. Settings - Basic Information - App Credentials'da Signing Secret seçin
            4. Bir Slash Komutları oluşturun ve İstek URL'si olarak koyun: https://your.domain.name/slack
        */
        enabled: false,
        signingSecret: '',
    },
    IPLookup: {
        /*
        GeoJS
            https://www.geojs.io/docs/v1/endpoints/geo/
        */
        enabled: false,
        getEndpoint(ip) {
            return `https://get.geojs.io/v1/ip/geo/${ip}.json`;
        },
    },
    survey: {
        /*
        QuestionPro
            1. Gidin https://www.questionpro.com/
            2. Hesap oluşturun
            3. Özel anketinizi oluşturun
        */
        enabled: false,
        url: '',
    },
    redirect: {
        /*
        Odadan ayrılırken URL'yi yönlendir Odadan çıktıktan sonra geri bildirim sağlamayı tercih etmeyen veya anketi devre dışı bırakılan kullanıcılar belirli bir URL'ye yönlendirilecektir. Yanlış etkinleştirilirse varsayılan '/newroom' URL'si kullanılacaktır.
        */
        enabled: false,
        url: '',
    },
    ui: {
        /*
            Örneğinizi özelleştirin
        */
        brand: {
            app: {
                name: 'SAI-GM Video Chat SFU',
                title: 'SAI-GM Video Chat SFU<br />Gerçek zamanlı görüntülü aramalar.<br />Basit, Güvenli, Hızlı.',
                description:
                    'Video görüşmenizi tek tıklamayla başlatın. Doğrudan konuşmaya, mesajlaşmaya ve ekranınızı paylaşmaya başlayın.',
            },
            site: {
                title: 'SAI-GM Video Chat SFU, Görüntülü Görüşme, Mesajlaşma ve Ekran Paylaşımı',
                icon: '../images/logo.svg',
                appleTouchIcon: '../images/logo.svg',
            },
            meta: {
                description:
                    'WebRTC ve mediasoup tarafından desteklenen SAI-GM Görüntülü Sohbet SFU, Gerçek Zamanlı Basit Güvenli Hızlı görüntülü aramalar, tarayıcıda mesajlaşma ve ekran paylaşımı özellikleri.',
                keywords:
                    'webrtc, miro, mediasoup, mediasoup-client, self hosted, voip, sip, real-time communications, chat, messaging, meet, webrtc stun, webrtc turn, webrtc p2p, webrtc sfu, video meeting, video chat, video conference, multi video chat, multi video conference, peer to peer, p2p, sfu, rtc, alternative to, zoom, microsoft teams, google meet, jitsi, meeting',
            },
            og: {
                type: 'app-webrtc',
                siteName: 'SAI-GM Video Chat SFU',
                title: 'Arama yapmak için bağlantıya tıklayın.',
                description: 'SAI-GM Video Chat SFU araması, gerçek zamanlı video görüşmeleri, mesajlaşma ve ekran paylaşımı sağlar.',
                image: 'https://sfu.alchemy.com.tr/images/saigmvideochatsfu.png',
                url: 'https://sfu.alchemy.com.tr',
            },
            html: {
                features: true,
                teams: false,
                tryEasier: true,
                poweredBy: true,
                sponsors: true,
                advertisers: true,
                footer: true,
            },
            //...
        },
        /*
            Oda içindeki belirli HTML öğelerinin görünürlüğünü değiştirin
        */
        buttons: {
            main: {
                shareButton: true, // sunumcu
                hideMeButton: true,
                startAudioButton: true,
                startVideoButton: true,
                startScreenButton: true,
                swapCameraButton: true,
                chatButton: true,
                raiseHandButton: true,
                transcriptionButton: false,
                whiteboardButton: true,
                emojiRoomButton: true,
                settingsButton: true,
                aboutButton: false,
                exitButton: true,
            },
            settings: {
                fileSharing: true,
                lockRoomButton: true, // sunumcu
                unlockRoomButton: true, // sunumcu
                broadcastingButton: true, // sunumcu
                lobbyButton: true, // sunumcu
                sendEmailInvitation: true, // sunumcu
                micOptionsButton: true, // sunumcu
                tabModerator: true, // sunumcu
                tabRecording: true,
                host_only_recording: true, // sunumcu
                pushToTalk: true,
            },
            producerVideo: {
                videoPictureInPicture: true,
                fullScreenButton: true,
                snapShotButton: true,
                muteAudioButton: true,
                videoPrivacyButton: true,
            },
            consumerVideo: {
                videoPictureInPicture: true,
                fullScreenButton: true,
                snapShotButton: true,
                sendMessageButton: true,
                sendFileButton: true,
                sendVideoButton: true,
                muteVideoButton: true,
                muteAudioButton: true,
                audioVolumeInput: true, // Mobil cihazlar için devre dışı bırakıldı
                geolocationButton: true, // Sunumcu
                banButton: true, // sunumcu
                ejectButton: true, // sunumcu
            },
            videoOff: {
                sendMessageButton: true,
                sendFileButton: true,
                sendVideoButton: true,
                muteAudioButton: true,
                audioVolumeInput: true, // Mobil cihazlar için devre dışı bırakıldı
                geolocationButton: true, // Sunumcu
                banButton: true, // sunumcu
                ejectButton: true, // sunumcu
            },
            chat: {
                chatPinButton: true,
                chatMaxButton: true,
                chatSaveButton: true,
                chatEmojiButton: true,
                chatMarkdownButton: true,
                chatSpeechStartButton: true,
                chatGPT: true,
            },
            participantsList: {
                saveInfoButton: true, // sunumcu
                sendFileAllButton: true, // sunumcu
                ejectAllButton: true, // sunumcu
                sendFileButton: true, // sunumcu & konuk
                geoLocationButton: true, // sunumcu
                banButton: true, // sunumcu
                ejectButton: true, // sunumcu
            },
            whiteboard: {
                whiteboardLockButton: true, // sunumcu
            },
            //...
        },
    },
    stats: {
        /*
            Umami: https://github.com/umami-software/umami
            Toplu kullanım istatistiklerini izlemek için Umami'yi kullanın.
        */
        enabled: false,
        src: 'https://stats.alchemy.com.tr/umamiScript.js',
        id: '41d26670-f275-45bb-af82-3ce91fe57756',
    },
    mediasoup: {
        // İşleyici ayarları
        numWorkers: numWorkers,
        worker: {
            logLevel: 'error',
            logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp', 'rtx', 'bwe', 'score', 'simulcast', 'svc', 'sctp'],
        },
        // Yönlendirici ayarları
        router: {
            audioLevelObserverEnabled: true,
            activeSpeakerObserverEnabled: false,
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters: {
                        'x-google-start-bitrate': 1000,
                    },
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP9',
                    clockRate: 90000,
                    parameters: {
                        'profile-id': 2,
                        'x-google-start-bitrate': 1000,
                    },
                },
                {
                    kind: 'video',
                    mimeType: 'video/h264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '4d0032',
                        'level-asymmetry-allowed': 1,
                        'x-google-start-bitrate': 1000,
                    },
                },
                {
                    kind: 'video',
                    mimeType: 'video/h264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',
                        'level-asymmetry-allowed': 1,
                        'x-google-start-bitrate': 1000,
                    },
                },
            ],
        },
        // WebRtcServerOptions
        webRtcServerActive: false,
        webRtcServerOptions: {
            listenInfos: [
                // { protocol: 'udp', ip: '0.0.0.0', announcedAddress: IPv4, port: 40000 },
                // { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: IPv4, port: 40000 },
                {
                    protocol: 'udp',
                    ip: '0.0.0.0',
                    announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || IPv4,
                    portRange: {
                        min: parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000,
                        max: (parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000) + numWorkers,
                    },
                },
                {
                    protocol: 'tcp',
                    ip: '0.0.0.0',
                    announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || IPv4,
                    portRange: {
                        min: parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000,
                        max: (parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000) + numWorkers,
                    },
                },
            ],
        },
        // WebRtcTransportOptions
        webRtcTransport: {
            listenInfos: [
                // { protocol: 'udp', ip: IPv4, portRange: { min: 40000, max: 40100 } },
                // { protocol: 'tcp', ip: IPv4, portRange: { min: 40000, max: 40100 } },
                {
                    protocol: 'udp',
                    ip: '0.0.0.0',
                    announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || IPv4,
                    portRange: {
                        min: parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000,
                        max: parseInt(process.env.MEDIASOUP_MAX_PORT) || 40100
                    },
                },
                {
                    protocol: 'tcp',
                    ip: '0.0.0.0',
                    announcedAddress: process.env.MEDIASOUP_ANNOUNCED_IP || IPv4,
                    portRange: {
                        min: parseInt(process.env.MEDIASOUP_MIN_PORT) || 40000,
                        max: parseInt(process.env.MEDIASOUP_MAX_PORT) || 40100
                    },
                },
            ],
            initialAvailableOutgoingBitrate: 1000000,
            minimumAvailableOutgoingBitrate: 600000,
            maxSctpMessageSize: 262144,
            maxIncomingBitrate: 1500000,
        },
        //announcedAddress: 'genel statik IPV4 adresi' ile değiştirin https://api.ipify.org (string yazın --> 'xx.xxx.xxx.xx', xx.xxx.xxx.xx değil)
        //announcedAddress: '' sunucu başlatıldığında otomatik olarak algılanacak, docker localPC için '127.0.0.1' ayarlanacak, aksi takdirde 'genel statik IPV4 adresi''
    },
};
