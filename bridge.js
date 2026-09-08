/*!
 * KABUT bridge — content script world "ISOLATED" v3.1
 *
 * Tugas:
 *  1. FASE SINKRON (document_start, sebelum parser lanjut):
 *     - membaca cache konfigurasi (sessionStorage — data publik tanpa
 *       identitas), lalu menurunkannya ke core (world MAIN) via ATRIBUT
 *       DOM pada <html> yang langsung dihapus core sebelum skrip halaman
 *       sempat berjalan → core memasang patch sejak MILIDETIK PERTAMA
 *       (menutup race event-vs-parser yang melekat pada MV3).
 *     - menghasilkan PAD acak per-load (kunci enkripsi satu kali) dan
 *       mengantarnya lewat atribut yang sama.
 *  2. FASE ASINKRON: membaca pengaturan + secret dari chrome.storage,
 *     menurunkan seed domain, lalu mengirim payload TERENKRIPSI (XOR pad)
 *     ke core via CustomEvent.
 *
 * PERBAIKAN KEAMANAN KRITIS (v2 membocorkan): event 'kabut-cfg' di v2
 * membawa seed MENTAH + allowlist + domainOverrides dalam teks polos —
 * skrip halaman mana pun dapat memasang listener dan MENCURI seed
 * (identifier pelacak per-domain permanen) beserta daftar situs
 * terpercaya pengguna. v3.1:
 *   - seed hanya berpindah TERENKRIPSI dengan pad acak per-load yang
 *     ditransfer lewat atribut DOM prinsenjat (tak terlihat halaman);
 *   - allowlist & domainOverrides TIDAK PERNAH menyeberang ke halaman;
 *   - cache sessionStorage hanya berisi konfigurasi tersanitasi
 *     (tanpa identitas apa pun).
 */
(function () {
'use strict';

/* Duplikat minimal PRNG (bridge tidak dapat memuat kabut-core.js). */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = c + ((c << 3) | 0) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
function makeRng(seedStr) {
  const s = xmur3(String(seedStr));
  return sfc32(s(), s(), s(), s());
}
function rngInt(rng) { return Math.floor(rng() * 4294967296) >>> 0; }
function hex8(n) {
  let s = (n >>> 0).toString(16);
  while (s.length < 8) s = '0' + s;
  return s;
}
function computeDomainSeed(secret, domain) {
  const rng = makeRng('kabut/domain-seed|' + String(secret) + '|' + String(domain));
  return hex8(rngInt(rng)) + hex8(rngInt(rng));
}

const K_EVENT = 'kabut-cfg';
const K_ATTR = 'data-kabut-boot';
const K_CACHE = 'ks-cfg';

/** Pad acak per-load: array byte 0-255 (panjang 1024) sebagai string koma. */
function makePad() {
  try {
    const a = new Uint8Array(1024);
    crypto.getRandomValues(a);
    const parts = new Array(a.length);
    for (let i = 0; i < a.length; i++) parts[i] = a[i];
    return parts.join(',');
  } catch (e) {
    /* Fallback PRNG (masih acak per-load). */
    const rng = makeRng('pad|' + Math.random() + '|' + Date.now());
    const parts = [];
    for (let i = 0; i < 1024; i++) parts.push(rngInt(rng) & 255);
    return parts.join(',');
  }
}

/** Enkripsi XOR: string → daftar kode (aman JSON, tanpa struktur). */
function encPayload(str, pad) {
  try {
    const pc = pad.split(',');
    const out = new Array(str.length);
    for (let i = 0; i < str.length; i++) {
      out[i] = (str.charCodeAt(i) ^ pc[i % pc.length]) & 255;
    }
    return out.join(',');
  } catch (e) { return null; }
}

/** Sanitasi konfigurasi: buang SEMUA data ber-identitas sebelum menyeberang. */
function sanitizeCfg(cfg) {
  try {
    const c = JSON.parse(JSON.stringify(cfg || {}));
    delete c.allowlist;
    delete c.domainOverrides;
    delete c.v;
    return c;
  } catch (e) { return null; }
}

function getDomain() {
  try {
    const h = location.hostname;
    if (h) return h;
    /* ancestorOrigins — origin leluhur terdekat untuk frame tanpa
     * hostname sendiri (about:blank/srcdoc/sandbox). */
    try {
      if (location.ancestorOrigins && location.ancestorOrigins.length) {
        const last = location.ancestorOrigins[location.ancestorOrigins.length - 1];
        if (last) {
          const host = new URL(last).hostname;
          if (host) return host;
        }
      }
    } catch (e) { /* lanjut fallback */ }
    let w = window.parent;
    while (w && w !== window) {
      try {
        const dh = w.location && w.location.hostname;
        if (dh) return dh;
      } catch (e) { /* lintas origin */ }
      w = w.parent;
    }
  } catch (e) {}
  try {
    const ref = document.referrer;
    if (ref) return new URL(ref).hostname;
  } catch (e) {}
  return 'unknown';
}

function isAllowlisted(domain, list) {
  if (!Array.isArray(list)) return false;
  const d = String(domain || '').toLowerCase();
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i] || '').toLowerCase().replace(/^\./, '');
    if (!a) continue;
    if (d === a || d.endsWith('.' + a)) return true;
  }
  return false;
}

/* ---------- FASE SINKRON (sebelum parser lanjut / skrip halaman) ---------- */

const dom0 = getDomain();
const pad0 = makePad();
let bootState = { en: true, cfg: null };

try {
  let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem(K_CACHE) || 'null'); } catch (e) {}
  /* en=false ter-cache (allowlist) → core tidak memasang patch sama sekali. */
  const enFlag = !(cached && cached.en === false);
  bootState = { en: enFlag, cfg: (cached && cached.cfg) || null };
  document.documentElement.setAttribute(K_ATTR, JSON.stringify({
    pad: pad0,
    dom: dom0,
    en: enFlag,
    cfg: bootState.cfg
  }));
} catch (e) {
  /* sessionStorage tak tersedia (sandbox dsb.) → atribut minimal (pad saja). */
  try {
    document.documentElement.setAttribute(K_ATTR, JSON.stringify({ pad: pad0, dom: dom0, en: true, cfg: null }));
  } catch (e2) { /* diam — event asinkron tetap berjalan */ }
}

/* ---------- FASE ASINKRON ---------- */

function dispatch(cfg, secret, domain) {
  try {
    const useSecret = (cfg.domainOverrides && cfg.domainOverrides[domain])
      ? String(cfg.domainOverrides[domain]) : String(secret);
    const seed = computeDomainSeed(useSecret, domain);
    const enabled = cfg.enabled !== false && !isAllowlisted(domain, cfg.allowlist);
    const payload = {
      enabled: enabled,
      cfg: sanitizeCfg(cfg),
      domain: domain,
      seed: seed
    };
    /* Perbarui cache utk load berikutnya (hanya data tersanitasi). */
    try { sessionStorage.setItem(K_CACHE, JSON.stringify({ en: enabled, cfg: payload.cfg })); } catch (e) {}
    /* Kirim terenkripsi (seed tak pernah polos di halaman). */
    const enc = encPayload(JSON.stringify(payload), pad0);
    if (enc) {
      document.dispatchEvent(new CustomEvent(K_EVENT, { detail: enc }));
      return;
    }
    /* Tanpa pad → kirim TANPA seed (core memakai seed provisional; cfg
     * tersanitasi bersifat publik). */
    const safe = { enabled: enabled, cfg: payload.cfg, domain: domain };
    document.dispatchEvent(new CustomEvent(K_EVENT, { detail: JSON.stringify(safe) }));
  } catch (e) { /* diam */ }
}

function readAndDispatch() {
  try {
    chrome.storage.local.get(['kabut', 'kabutSecret'], function (st) {
      let cfg = (st && st.kabut) || null;
      if (!cfg || typeof cfg !== 'object') cfg = {};
      const secret = (st && st.kabutSecret) || 'kabut-ephemeral';
      dispatch(cfg, secret, dom0);
    });
  } catch (e) { /* fallback timeout di core akan menyala proteksi default */ }
}

readAndDispatch();

try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.kabut || changes.kabutSecret) readAndDispatch();
  });
} catch (e) {}

try {
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'kabut-cfg-update') readAndDispatch();
  });
} catch (e) {}
})();
