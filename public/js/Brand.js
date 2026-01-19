'use strict';

const brandDataKey = 'brandData';
const brandData = window.sessionStorage.getItem(brandDataKey);

const title = document.getElementById('title');
const icon = document.getElementById('icon');
const appleTouchIcon = document.getElementById('appleTouchIcon');

const description = document.getElementById('description');
const keywords = document.getElementById('keywords');

const ogType = document.getElementById('ogType');
const ogSiteName = document.getElementById('ogSiteName');
const ogTitle = document.getElementById('ogTitle');
const ogDescription = document.getElementById('ogDescription');
const ogImage = document.getElementById('ogImage');
const ogUrl = document.getElementById('ogUrl');

const appTitle = document.getElementById('appTitle');
const appDescription = document.getElementById('appDescription');

const features = document.getElementById('features');
const teams = document.getElementById('teams');
const tryEasier = document.getElementById('tryEasier');
const poweredBy = document.getElementById('poweredBy');
const sponsors = document.getElementById('sponsors');
const advertisers = document.getElementById('advertisers');
const footer = document.getElementById('footer');
//...

// app/src/config.js - ui.brand
let BRAND = {
    app: {
        name: 'SAI-GM Video Chat SFU',
        title: 'SAI-GM Video SFU<br />Tarayıcı tabanlı Gerçek zamanlı video görüşmeleri.<br />Basit, Güvenli, Hızlı.',
        description:
            'Bir sonraki video görüşmenizi tek tıklamayla başlatın. İndirmeye, eklentiye veya oturum açmaya gerek yoktur. Doğrudan konuşmaya ve ekranınızı paylaşmaya başlayın.',
    },
    site: {
        title: 'SAI-GM Video Chat SFU, Görüntülü Görüşme ve Ekran Paylaşımı',
        icon: '../images/logo.svg',
        appleTouchIcon: '../images/logo.svg',
    },
    meta: {
        description:
            'WebRTC ve mediasoup tarafından desteklenen SAI-GM Video Chat SFU, Gerçek Zamanlı Basit Güvenli Hızlı görüntülü aramalar ve ekran paylaşımı özellikleri.',
        keywords:
            'webrtc, SAI-GM Video Chat, mediasoup, mediasoup-client, self hosted, voip, sip, real-time communications, chat, messaging, meet, webrtc stun, webrtc turn, webrtc p2p, webrtc sfu, video meeting, video chat, video conference, multi video chat, multi video conference, peer to peer, p2p, sfu, rtc, alternative to, zoom, microsoft teams, google meet, jitsi, meeting',
    },
    og: {
        type: 'app-webrtc',
        siteName: 'SAI-GM Video Chat SFU',
        title: 'Arama yapmak için bağlantıya tıklayın.',
        description: 'SAI-GM Video Chat SFU, gerçek zamanlı video görüşmeleri ve ekran paylaşımı sağlar.',
        image: '',
        url: 'https://alchemy.com.tr',
    },
    html: {
        features: true,
        teams: true,
        tryEasier: true,
        poweredBy: true,
        sponsors: false,
        advertisers: false,
        footer: true,
    },
    //...
};

async function initialize() {
    await getBrand();

    customizeSite();

    customizeMetaTags();

    customizeOpenGraph();

    customizeApp();

    checkBrand();
}

async function getBrand() {
    if (brandData) {
        setBrand(JSON.parse(brandData));
    } else {
        try {
            const response = await fetch('/brand', { timeout: 5000 });
            if (!response.ok) {
                throw new Error('Ağ yanıtı iyi değildi');
            }
            const data = await response.json();
            const serverBrand = data.message;
            if (serverBrand) {
                setBrand(serverBrand);
                console.log('MARKA AYARLARINI GETİR', {
                    serverBrand: serverBrand,
                    clientBrand: BRAND,
                });
                window.sessionStorage.setItem(brandDataKey, JSON.stringify(serverBrand));
            }
        } catch (error) {
            console.error('MARKA HATASI ALINDI', error.message);
        }
    }
}

// MARkA ayarları
function setBrand(data) {
    BRAND = data;
    console.log('Marka Ayarı tamamlandı');
}

// MARkA kontrol
function checkBrand() {
    !BRAND.html.features && elementDisplay(features, false);
    !BRAND.html.teams && elementDisplay(teams, false);
    !BRAND.html.tryEasier && elementDisplay(tryEasier, false);
    !BRAND.html.poweredBy && elementDisplay(poweredBy, false);
    !BRAND.html.sponsors && elementDisplay(sponsors, false);
    !BRAND.html.advertisers && elementDisplay(advertisers, false);
    !BRAND.html.footer && elementDisplay(footer, false);
}

// ELEMENT ekran modu
function elementDisplay(element, display, mode = 'block') {
    if (!element) return;
    element.style.display = display ? mode : 'none';
}

// UYGULAMAYI özelleştir
function customizeApp() {
    if (appTitle) {
        appTitle.innerHTML = BRAND.app.title;
    }
    if (appDescription) {
        appDescription.textContent = BRAND.app.description;
    }
}

// SİTE meta verileri
function customizeSite() {
    if (title) {
        title.textContent = BRAND.site.title;
    }
    if (icon) {
        icon.href = BRAND.site.icon;
    }
    if (appleTouchIcon) {
        appleTouchIcon.href = BRAND.site.appleTouchIcon;
    }
}

// SEO meta verileri
function customizeMetaTags() {
    if (description) {
        description.content = BRAND.meta.description;
    }
    if (keywords) {
        keywords.content = BRAND.meta.keywords;
    }
}

// SOSYAL MEDYA PAYLAŞIMI meta verileri
function customizeOpenGraph() {
    if (ogType) {
        ogType.content = BRAND.og.type;
    }
    if (ogSiteName) {
        ogSiteName.content = BRAND.og.siteName;
    }
    if (ogTitle) {
        ogTitle.content = BRAND.og.title;
    }
    if (ogDescription) {
        ogDescription.content = BRAND.og.description;
    }
    if (ogImage) {
        ogImage.content = BRAND.og.image;
    }
    if (ogUrl) {
        ogUrl.content = BRAND.og.url;
    }
}

initialize();
