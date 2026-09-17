'use strict';

/**
 * visemes.js
 * ----------
 * TTS sesinden (16 kHz, mono, PCM16) bir "viseme" (agiz sekli) zaman
 * cizelgesi cikarir. Cikti client'a socket.io ile gonderilir ve orada
 * (Rive avatar / prosedurel fallback) canlandirilir - yani sunucu ARTIK
 * video encode etmiyor, sadece birkac kilobayt metadata uretiyor.
 *
 * Bunun yerini aldigi eski yaklasim: AiConferencePeer.js icinde 120ms'lik
 * RMS pencerelerini 3 sabit agiz karesine (kapali/yari/acik) eslemek ve
 * ffmpeg ile VP8 RTP'ye encode edip odaya ayri bir video producer olarak
 * basmak. O yaklasim her utterance icin bir ffmpeg encode + ~300kbps
 * downlink + her seferinde taze bir mediasoup producer (mobilde
 * videoEnabled titremesine yol aciyordu) maliyeti tasiyordu.
 *
 * ONEMLI - bu bir FONEM HIZALAYICI (forced aligner) DEGIL:
 * TTS'ten fonem zamanlamasi almadigimiz icin agiz sekli tamamen akustik
 * ipuclarindan (bant enerjileri + RMS) TAHMIN ediliyor. Bilinen ve kabul
 * edilen sinirlari:
 *   - Turkce'nin on-yuvarlak unluleri (o, u) 'E' olarak cikar; yuvarlaklik
 *     F2'de ayirt edilecek kadar belirgin degil (o F2~1600 / e F2~1900).
 *   - 's' ve 'f' ayrimi zayif; ikisi de "dar agiz" grubunda oldugu icin
 *     gorsel etkisi kucuk.
 *   - Cok hizli konusmada gecis sesleri (geminate, patlamalilar) atlanabilir.
 * Pratikte animasyonu inandirici yapan sey viseme kimliginden cok dogru
 * ZAMANLAMA ve agiz acikligi MIKTARI (intensity) - ikisi de bu yaklasimla
 * iyi calisiyor. TTS saglayicisi fonem zamanlamasi vermeye baslarsa
 * buildVisemeTimeline yerine dogrudan o zamanlama beslenebilir; cikti
 * formati ayni kalir ve client'ta hicbir sey degismez.
 *
 * Asagidaki esikler sentetik Turkce formant tonlariyla (a 730/1200,
 * e 530/1900, i 270/2300, i 350/1400, o 500/900, u 300/800, o 470/1600,
 * u 320/1800 Hz) olculup kalibre edildi - bkz. scripts/test_visemes.js.
 * Gercek TTS sesi bunlardan daha gurultulu; sahada ince ayar gerekirse
 * degistirilecek yer burasi.
 */

const SAMPLE_RATE = 16000;

// 40ms pencere = 25 fps. Eski 120ms (8.3 fps) dudak senkronu icin cok
// kabaydi; 25 fps insan gozunun konusan agizda bekledigi cozunurluk.
const WINDOW_MS = 40;

// Bir viseme kosusu bundan kisaysa komsusuna yutturulur - tek pencerelik
// sicramalar agzi "titrek" gosteriyor.
const MIN_RUN_MS = 80;

// --- Siniflandirma esikleri (yukaridaki kalibrasyon notuna bakin) --------
// Pencere RMS'i utterance tepe degerinin bu katindan kucukse agiz kapali.
// Sabit dB esigi yerine oran: TTS ciktilarinin genel seviyesi degisiyor.
const SILENCE_RATIO = 0.06;
// Enerjinin bu kadari 2.7kHz ustundeyse unlu degil, surtunmeli bir sessiz.
// Olculen: unluler 0.006-0.114, surtunmeliler 0.805-0.894.
const FRICATIVE_RATIO = 0.45;
// Surtunmeli icinde tislamanin (5.5kHz ustu) payi: 's' 0.41, 's'/'f' <0.09.
const SIBILANT_RATIO = 0.25;
// Seslendirilmis ama bu kadar sessiz = dudak kapanmasi / geniz sesi (m,b,p,n).
const CLOSURE_LOUDNESS = 0.22;
// F2 agirligi: yayvan/on unluler (e,i,i) vs yuvarlak/arka (a,o,u).
// Olculen: i 0.417, e 0.810, i 0.891 / a 0.274, o 0.234, u 0.206.
const FRONTNESS_SPREAD = 0.34;
// Genis acik cene (a): olculen a 0.914, o 0.780, u 0.417.
const JAW_OPEN_WIDE = 0.6;
// Acik cene icinde 'a'yi 'o'dan ayiran F1 yuksekligi: a 0.838, o 0.275.
const JAW_WIDE = 0.55;
// Orta acik yuvarlak (o): o 0.780, u 0.417.
const JAW_OPEN_ROUND = 0.55;

// Wire formatinda yeni bir giris ancak viseme degistiginde YA DA aciklik bu
// kadar degistiginde yaziliyor (kaba bir run-length encoding).
const INTENSITY_STEP = 0.12;

// Cok uzun bir utterance'in payload'i sismesin diye ust sinir; asilirsa
// aciklik esigi kademeli buyutulup tekrar denenir.
const MAX_ENTRIES = 600;

/**
 * Client'in bilmesi gereken viseme kumesi. Rive state machine'inde
 * `viseme` numeric input'u bu dizideki INDEX'i alir - sira ASLA
 * degistirilmemeli, sadece sonuna ekleme yapilabilir.
 */
const VISEME_SET = ['sil', 'MBP', 'FV', 'S', 'E', 'AA', 'O', 'U'];

/**
 * RBJ Audio EQ Cookbook bandpass biquad'i (sabit 0 dB tepe kazanci).
 * Tam bir FFT'ye gerek yok: sadece bant enerjileri istiyoruz, bu da sinyali
 * bant bant filtreleyip pencere pencere RMS almakla O(N) maliyetle cikiyor.
 */
function bandpassCoeffs(freq, q) {
  const w0 = (2 * Math.PI * freq) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Bir bandi [lowHz, highHz] gecirecek biquad katsayilari. */
function bandFor(lowHz, highHz) {
  const center = Math.sqrt(lowHz * highHz);
  const q = center / (highHz - lowHz);
  return bandpassCoeffs(center, Math.max(0.4, q));
}

// Tek biquad'in etek egimi (-6 dB/oktav) bantlarin birbirine sizmasina yol
// aciyor; olcumle dogrulandi: tek gecisle surtunmeli/unlu ayrimi 0.60 vs
// 0.16'ya kadar yaklasirken, ayni biquad'i iki kez uygulayinca (4. derece)
// 0.81 vs 0.05'e aciliyor. Maliyet iki kati ama yine onemsiz.
const BAND_PASSES = 2;

// Konusma icin secilen bantlar. f1*/f2* sinirlari Turkce unlu formantlarina
// gore bolundu: F1 cene acikligini, F2 dudak yayvanligini/yuvarlakligini
// tasiyor.
const BANDS = [
  { key: 'f0', coeffs: bandFor(80, 250) }, // perde; sekle katkisi yok, toplamda sayiliyor
  { key: 'f1c', coeffs: bandFor(250, 450) }, // kapali unlu F1: i, u, u (~270-320)
  { key: 'f1m', coeffs: bandFor(450, 620) }, // orta unlu F1: o, e, o (~470-530)
  { key: 'f1o', coeffs: bandFor(620, 900) }, // acik unlu F1: a (~730)
  { key: 'f2b', coeffs: bandFor(900, 1500) }, // arka/yuvarlak F2: u, o, a, i
  { key: 'f2f', coeffs: bandFor(1500, 2700) }, // on/yayvan F2: o, u, e, i
  { key: 'fric', coeffs: bandFor(2700, 5500) }, // f, v, s
  { key: 'sib', coeffs: bandFor(5500, 7700) }, // s, z tislamasi
];

/** PCM16 buffer'i Float32'ye cevirir (-1..1). */
function pcmToFloat(pcm) {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

/** Direct Form I biquad, tek gecis. */
function applyBiquad(samples, c) {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** Pencere pencere RMS. */
function windowRms(samples, samplesPerWindow) {
  const count = Math.ceil(samples.length / samplesPerWindow);
  const out = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    const start = w * samplesPerWindow;
    const end = Math.min(start + samplesPerWindow, samples.length);
    let sumSq = 0;
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i];
    out[w] = Math.sqrt(sumSq / Math.max(1, end - start));
  }
  return out;
}

/**
 * Tek bir pencerenin bant enerjilerinden agiz seklini secer.
 * Tamamen sezgisel (bkz. dosya basindaki "FONEM HIZALAYICI DEGIL" notu).
 *
 * @param {{ loud: number, bands: Record<string, number> }} input
 *        loud: pencere RMS'inin utterance tepesine orani (0..1)
 * @returns {string} VISEME_SET icinden bir anahtar
 */
function classifyWindow({ loud, bands }) {
  if (loud < SILENCE_RATIO) return 'sil';

  const total =
    bands.f0 + bands.f1c + bands.f1m + bands.f1o + bands.f2b + bands.f2f + bands.fric + bands.sib || 1e-9;

  // Surtunmeli sessizler: enerji formant bolgesinin cok ustunde.
  if ((bands.fric + bands.sib) / total > FRICATIVE_RATIO) {
    return bands.sib / (bands.sib + bands.fric || 1e-9) > SIBILANT_RATIO ? 'S' : 'FV';
  }

  // Seslendirilmis ama cok sessiz: dudaklar kapali (m, b, p) ya da geniz (n).
  if (loud < CLOSURE_LOUDNESS) return 'MBP';

  const frontness = bands.f2f / (bands.f2b + bands.f2f || 1e-9);
  // Yayvan dudak (on unluler). Turkce'nin on-yuvarlak o/u'su de buraya
  // dusuyor - bilinen bir yaklasim hatasi (dosya basindaki nota bakin).
  if (frontness > FRONTNESS_SPREAD) return 'E';

  const jawOpen = (bands.f1m + bands.f1o) / (bands.f1c + bands.f1m + bands.f1o || 1e-9);
  const jawWide = bands.f1o / (bands.f1m + bands.f1o || 1e-9);
  if (jawOpen > JAW_OPEN_WIDE && jawWide > JAW_WIDE) return 'AA'; // a
  if (jawOpen > JAW_OPEN_ROUND) return 'O'; // o
  return 'U'; // u, i
}

/** 3'lu medyan: tek pencerelik sicramalari temizler. */
function medianSmooth(keys) {
  if (keys.length < 3) return keys.slice();
  const out = keys.slice();
  for (let i = 1; i < keys.length - 1; i++) {
    // Komsular birbirine esit ama ortadaki farkliysa ortadaki gurultudur.
    if (keys[i - 1] === keys[i + 1] && keys[i] !== keys[i - 1]) out[i] = keys[i - 1];
  }
  return out;
}

/** MIN_RUN_MS'den kisa kosulari onceki kosuya yutturur. */
function absorbShortRuns(keys, windowMs) {
  const minWindows = Math.max(1, Math.round(MIN_RUN_MS / windowMs));
  const out = keys.slice();
  let runStart = 0;
  for (let i = 1; i <= out.length; i++) {
    if (i < out.length && out[i] === out[runStart]) continue;
    const runLength = i - runStart;
    // Ilk kosuyu yutturacak bir "onceki" yok; sessizligi de koruyoruz
    // (kisa duraklar konusmayi dogal gosteriyor).
    if (runLength < minWindows && runStart > 0 && out[runStart] !== 'sil') {
      const prev = out[runStart - 1];
      for (let j = runStart; j < i; j++) out[j] = prev;
    }
    runStart = i;
  }
  return out;
}

/**
 * Aciklik (intensity) yumusatma: agiz hizli acilir, yavas kapanir. Ayni
 * attack/release orani konusan yuzu mekanik yerine organik gosteriyor.
 */
function smoothIntensity(raw) {
  const ATTACK = 0.6;
  const RELEASE = 0.25;
  const out = new Float32Array(raw.length);
  let prev = 0;
  for (let i = 0; i < raw.length; i++) {
    const target = raw[i];
    prev += (target - prev) * (target > prev ? ATTACK : RELEASE);
    out[i] = prev;
  }
  return out;
}

/** Kaba run-length encoding: viseme degisimi ya da belirgin aciklik degisimi. */
function encode(keys, intensity, windowMs, step) {
  const entries = [];
  let lastKey = null;
  let lastIntensity = -1;
  for (let i = 0; i < keys.length; i++) {
    const v = keys[i];
    const inten = Math.round(intensity[i] * 100) / 100;
    if (v !== lastKey || Math.abs(inten - lastIntensity) >= step) {
      entries.push({ t: Math.round(i * windowMs), v, i: inten });
      lastKey = v;
      lastIntensity = inten;
    }
  }
  return entries;
}

function emptyTimeline(durationMs, windowMs) {
  return {
    durationMs,
    frameMs: windowMs,
    visemeSet: VISEME_SET,
    visemes: [{ t: 0, v: 'sil', i: 0 }],
  };
}

/**
 * PCM16 mono 16kHz buffer -> viseme zaman cizelgesi.
 *
 * @param {Buffer} pcm
 * @param {{ sampleRate?: number, windowMs?: number }} [options]
 * @returns {{ durationMs: number, frameMs: number, visemeSet: string[],
 *             visemes: Array<{ t: number, v: string, i: number }> }}
 *          `visemes` t'ye gore artan sirali; her giris "bu andan sonraki
 *          girise kadar bu agiz sekli" anlamina gelir.
 */
function buildVisemeTimeline(pcm, options = {}) {
  const windowMs = options.windowMs || WINDOW_MS;
  const sampleRate = options.sampleRate || SAMPLE_RATE;
  const samplesPerWindow = Math.max(1, Math.round((sampleRate * windowMs) / 1000));

  const samples = pcmToFloat(pcm);
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  if (samples.length < samplesPerWindow) return emptyTimeline(durationMs, windowMs);

  const broadband = windowRms(samples, samplesPerWindow);
  const bandRms = {};
  for (const band of BANDS) {
    let filtered = samples;
    for (let pass = 0; pass < BAND_PASSES; pass++) filtered = applyBiquad(filtered, band.coeffs);
    bandRms[band.key] = windowRms(filtered, samplesPerWindow);
  }

  let peak = 0;
  for (let i = 0; i < broadband.length; i++) if (broadband[i] > peak) peak = broadband[i];
  if (peak <= 0) return emptyTimeline(durationMs, windowMs);

  const rawKeys = [];
  const rawIntensity = new Float32Array(broadband.length);
  for (let i = 0; i < broadband.length; i++) {
    const loud = broadband[i] / peak;
    const bands = {};
    for (const band of BANDS) bands[band.key] = bandRms[band.key][i];
    const key = classifyWindow({ loud, bands });
    rawKeys.push(key);
    // sqrt egrisi: dogrusal RMS agzi fazla kapali gosteriyor, cunku algilanan
    // gurultu enerjinin karekokune daha yakin.
    rawIntensity[i] = key === 'sil' ? 0 : Math.min(1, Math.sqrt(loud));
  }

  const keys = absorbShortRuns(medianSmooth(rawKeys), windowMs);
  const intensity = smoothIntensity(rawIntensity);
  // Yumusatmanin release kuyrugu sessizlik sinirini asabiliyor; 'sil'
  // girisinin aciklikla birlikte gitmesi celiskili (client yarim acik bir
  // "kapali agiz" cizer). Sunucu HEDEF degeri gonderir, aradaki yumusak
  // kapanmayi client kendi kare hizinda tween ederek uretir.
  for (let i = 0; i < keys.length; i++) if (keys[i] === 'sil') intensity[i] = 0;

  let step = INTENSITY_STEP;
  let visemes = encode(keys, intensity, windowMs, step);
  // Payload ust siniri: aciklik esigini buyutmek giris sayisini dusurur;
  // viseme degisimleri her halukarda korunur.
  while (visemes.length > MAX_ENTRIES && step < 1) {
    step *= 1.5;
    visemes = encode(keys, intensity, windowMs, step);
  }

  return { durationMs, frameMs: windowMs, visemeSet: VISEME_SET, visemes };
}

module.exports = {
  buildVisemeTimeline,
  VISEME_SET,
  WINDOW_MS,
  // Testler / olasi yeniden kullanim icin aciliyor.
  _internals: { classifyWindow, medianSmooth, absorbShortRuns, windowRms, applyBiquad, bandFor, BANDS, BAND_PASSES },
};
