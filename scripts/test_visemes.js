'use strict';

/**
 * src/visemes.js icin bagimsiz dogrulama scripti. Bu repoda bir test
 * framework'u kurulu olmadigi icin duz node + assert kullaniyor:
 *
 *   node scripts/test_visemes.js
 *
 * Cikis kodu 0 = tum kontroller gecti.
 *
 * Sentetik "unlu" sinyalleri perde (F0) + iki formant sinusu olarak
 * uretiliyor; frekanslar Turkce unlulerin yaklasik formant degerleri.
 * Gercek TTS sesi bunlardan daha gurultulu - bu testler siniflandiricinin
 * DOGRU YONDE calistigini dogrular, saha dogrulugunu garanti etmez.
 */

const assert = require('assert');
const { buildVisemeTimeline, VISEME_SET } = require('../src/visemes');

const SR = 16000;

/** F0 + F1 + F2 (+ zayif bir F3) sinuslerinden PCM16 mono unlu uretir. */
function vowel(durationSec, f1, f2, amplitude = 0.6) {
  const n = Math.round(SR * durationSec);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v =
      (amplitude *
        (0.35 * Math.sin((2 * Math.PI * 130 * i) / SR) +
          1.0 * Math.sin((2 * Math.PI * f1 * i) / SR) +
          0.6 * Math.sin((2 * Math.PI * f2 * i) / SR) +
          0.2 * Math.sin((2 * Math.PI * f2 * 1.6 * i) / SR))) /
      2.2;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  return buf;
}

/** [lo, hi] arasinda yogun gurultu - surtunmeli sessizlerin kaba modeli. */
function bandNoise(durationSec, lo, hi, amplitude = 0.6) {
  const n = Math.round(SR * durationSec);
  const buf = Buffer.alloc(n * 2);
  const comps = [];
  for (let f = lo; f <= hi; f += 37) comps.push({ f, ph: Math.random() * 2 * Math.PI });
  const norm = Math.sqrt(comps.length);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const c of comps) v += Math.sin((2 * Math.PI * c.f * i) / SR + c.ph);
    v = (v / norm) * amplitude;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
  }
  return buf;
}

function silence(durationSec) {
  return Buffer.alloc(Math.round(SR * durationSec) * 2);
}

/** Zaman cizelgesinde en uzun sure kaplayan viseme. */
function dominantViseme(timeline) {
  const totals = new Map();
  const { visemes, durationMs } = timeline;
  for (let i = 0; i < visemes.length; i++) {
    const end = i + 1 < visemes.length ? visemes[i + 1].t : durationMs;
    const span = Math.max(0, end - visemes[i].t);
    totals.set(visemes[i].v, (totals.get(visemes[i].v) || 0) + span);
  }
  let best = null;
  let bestSpan = -1;
  for (const [v, span] of totals) {
    if (span > bestSpan) {
      best = v;
      bestSpan = span;
    }
  }
  return best;
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// --- temel dayaniklilik ---------------------------------------------------

check('sessizlik tamamen kapali agiz verir', () => {
  assert.strictEqual(dominantViseme(buildVisemeTimeline(silence(1))), 'sil');
});

check('bos / cok kisa buffer cokmez, tek sil girisi verir', () => {
  for (const buf of [Buffer.alloc(0), Buffer.alloc(20)]) {
    assert.deepStrictEqual(buildVisemeTimeline(buf).visemes, [{ t: 0, v: 'sil', i: 0 }]);
  }
});

check('DC / tek yonlu sinyal cokmez', () => {
  const n = SR;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(12000, i * 2);
  const t = buildVisemeTimeline(buf);
  assert.ok(t.visemes.length >= 1);
  for (const e of t.visemes) assert.ok(VISEME_SET.includes(e.v));
});

// --- Turkce unluler ------------------------------------------------------
// Beklenen esleme GORSEL agiz sekli: e/i/i yayvan (E), a genis acik (AA),
// o yuvarlak-orta (O), u yuvarlak-kapali (U). o/u'nun E'ye dusmesi
// visemes.js'te belgelenmis bilinen bir yaklasim hatasi.

const VOWEL_CASES = [
  { name: 'a', f1: 730, f2: 1200, expect: 'AA' },
  { name: 'e', f1: 530, f2: 1900, expect: 'E' },
  { name: 'i', f1: 270, f2: 2300, expect: 'E' },
  { name: 'i (noktasiz)', f1: 350, f2: 1400, expect: 'E' },
  { name: 'o', f1: 500, f2: 900, expect: 'O' },
  { name: 'u', f1: 300, f2: 800, expect: 'U' },
];

for (const { name, f1, f2, expect } of VOWEL_CASES) {
  check(`unlu "${name}" (F1=${f1} F2=${f2}) -> ${expect}`, () => {
    const got = dominantViseme(buildVisemeTimeline(vowel(1, f1, f2)));
    assert.strictEqual(got, expect, `beklenen ${expect}, gelen ${got}`);
  });
}

check('on-yuvarlak o/u bilinen sekilde E olarak cikar (regresyon kaydi)', () => {
  // Bu bir HATA DEGIL, belgelenmis bir sinir: F2 farki (o~1600, e~1900)
  // yuvarlakligi ayirmaya yetmiyor. Davranis degisirse bu test uyarir.
  assert.strictEqual(dominantViseme(buildVisemeTimeline(vowel(1, 470, 1600))), 'E');
  assert.strictEqual(dominantViseme(buildVisemeTimeline(vowel(1, 320, 1800))), 'E');
});

// --- surtunmeli sessizler ------------------------------------------------

check('tislama "s" (3.8-7.6k) -> S', () => {
  assert.strictEqual(dominantViseme(buildVisemeTimeline(bandNoise(1, 3800, 7600))), 'S');
});

check('"s" / "f" dar agiz grubuna dusuyor (S ya da FV)', () => {
  for (const [lo, hi] of [[2800, 6000], [3000, 5500]]) {
    const got = dominantViseme(buildVisemeTimeline(bandNoise(1, lo, hi)));
    assert.ok(['S', 'FV'].includes(got), `${lo}-${hi}Hz icin beklenen S/FV, gelen ${got}`);
  }
});

check('surtunmeli unluden ayirt ediliyor (karsilastirmali)', () => {
  const fricative = dominantViseme(buildVisemeTimeline(bandNoise(1, 3800, 7600)));
  const vowelShape = dominantViseme(buildVisemeTimeline(vowel(1, 730, 1200)));
  assert.notStrictEqual(fricative, vowelShape);
  assert.ok(['S', 'FV'].includes(fricative));
  assert.ok(!['S', 'FV'].includes(vowelShape));
});

// --- zaman cizelgesi sozlesmesi ------------------------------------------

check('cizelge t=0 ile baslar, sureyi asmaz, gecerli degerler tasir', () => {
  const t = buildVisemeTimeline(vowel(2, 730, 1200));
  assert.strictEqual(t.visemes[0].t, 0);
  assert.ok(t.durationMs >= 1900 && t.durationMs <= 2100, `sure ${t.durationMs}`);
  assert.strictEqual(t.frameMs, 40);
  assert.deepStrictEqual(t.visemeSet, VISEME_SET);
  for (const e of t.visemes) {
    assert.ok(e.t >= 0 && e.t <= t.durationMs, `t=${e.t} sure disinda`);
    assert.ok(VISEME_SET.includes(e.v), `bilinmeyen viseme ${e.v}`);
    assert.ok(e.i >= 0 && e.i <= 1, `intensity ${e.i} aralik disinda`);
  }
});

check('t degerleri kesin artan sirada', () => {
  const t = buildVisemeTimeline(vowel(3, 530, 1900));
  for (let i = 1; i < t.visemes.length; i++) {
    assert.ok(t.visemes[i].t > t.visemes[i - 1].t, `t artmiyor: ${t.visemes[i - 1].t} -> ${t.visemes[i].t}`);
  }
});

check('sessizlik-konusma-sessizlik gecisleri yakalanir', () => {
  const pcm = Buffer.concat([silence(0.4), vowel(0.8, 730, 1200), silence(0.4)]);
  const t = buildVisemeTimeline(pcm);
  const kinds = new Set(t.visemes.map((e) => e.v));
  assert.strictEqual(t.visemes[0].v, 'sil', 'sessizlikle baslamiyor');
  assert.ok(kinds.has('AA'), 'konusma bolumu yakalanmadi');
  // Son giris tekrar sessizlige donmeli.
  assert.strictEqual(t.visemes[t.visemes.length - 1].v, 'sil', 'sessizlige donmuyor');
});

check('kisa tek-pencere sicramalari yumusatiliyor', () => {
  // 1s "a" icinde 40ms'lik tek bir tislama parcasi - MIN_RUN_MS (80ms)
  // altinda oldugu icin cizelgeye ayri bir kosu olarak girmemeli.
  const pcm = Buffer.concat([vowel(0.5, 730, 1200), bandNoise(0.04, 3800, 7600), vowel(0.5, 730, 1200)]);
  const t = buildVisemeTimeline(pcm);
  const runs = t.visemes.filter((e) => e.v === 'S').length;
  assert.strictEqual(runs, 0, `40ms'lik parazit ${runs} kosu olarak gecti`);
});

check("'sil' girisleri her zaman sifir aciklikla gelir", () => {
  // Aksi halde client kapali agzi yarim acik cizer; yumusak kapanma
  // client'in kendi tween'inin isi (bkz. visemes.js icindeki not).
  const pcm = Buffer.concat([vowel(0.6, 730, 1200), silence(0.6), vowel(0.6, 530, 1900)]);
  for (const e of buildVisemeTimeline(pcm).visemes) {
    if (e.v === 'sil') assert.strictEqual(e.i, 0, `sil girisi i=${e.i} ile geldi`);
  }
});

check('gercekci hece dizisi anlamli bir hareket cizelgesi uretir', () => {
  // 'merhaba ... nasil ...' benzeri bir dizi; amac cizelgenin duz/olu
  // kalmadigini ve birden fazla agiz seklini kullandigini dogrulamak.
  const V = { a: [730, 1200], e: [530, 1900], i: [270, 2300], o: [500, 900], u: [300, 800] };
  const seq = 'merhaba_bugun_nasil_hissediyorsunuz'.split('');
  const parts = [];
  for (const ch of seq) {
    if (ch === '_') parts.push(silence(0.12));
    else if ('aeiou'.includes(ch)) parts.push(vowel(0.11, V[ch][0], V[ch][1]));
    else if ('sz'.includes(ch)) parts.push(bandNoise(0.09, 3800, 7600));
    else if ('hf'.includes(ch)) parts.push(bandNoise(0.07, 3000, 5500));
    else parts.push(vowel(0.05, 300, 800, 0.15)); // kapanma/patlamali yaklasimi
  }
  const t = buildVisemeTimeline(Buffer.concat(parts));
  const kinds = new Set(t.visemes.map((e) => e.v));
  console.log(`    (~3s hece dizisi -> ${t.visemes.length} giris, ${kinds.size} farkli viseme)`);
  assert.ok(t.visemes.length >= 15, `cizelge fazla duz: ${t.visemes.length} giris`);
  assert.ok(kinds.size >= 5, `fazla az agiz sekli kullanildi: ${[...kinds].join(',')}`);
  assert.ok(kinds.has('sil'), 'duraklar yakalanmadi');
});

// --- butce -------------------------------------------------------------

check('uzun utterance payload ust sinirini asmaz', () => {
  const n = SR * 60;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const f = 300 + 1500 * Math.abs(Math.sin((2 * Math.PI * i) / (SR * 0.35)));
    buf.writeInt16LE(Math.round(0.6 * Math.sin((2 * Math.PI * f * i) / SR) * 32767), i * 2);
  }
  const t = buildVisemeTimeline(buf);
  const bytes = Buffer.byteLength(JSON.stringify(t), 'utf8');
  console.log(`    (60s utterance -> ${t.visemes.length} giris, ${bytes} bayt JSON)`);
  assert.ok(t.visemes.length <= 600, `giris sayisi ${t.visemes.length} > 600`);
  assert.ok(bytes < 40000, `payload ${bytes} bayt fazla buyuk`);
});

check('tipik utterance (8s) CPU butcesi icinde cikariliyor', () => {
  const pcm = vowel(8, 530, 1900);
  const started = Date.now();
  buildVisemeTimeline(pcm);
  const elapsed = Date.now() - started;
  console.log(`    (8s ses -> ${elapsed}ms cikarma)`);
  // CPU'lu sunucuda turn gecikmesine anlamli bir sey eklememeli.
  assert.ok(elapsed < 400, `cikarma ${elapsed}ms cok yavas`);
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} kontrol gecti`);
process.exit(failed ? 1 : 0);
