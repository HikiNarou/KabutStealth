/*!
 * KABUT — Stealth & Anti-Fingerprinting Shield (Core) v3.0.0
 * File ini adalah content script world "MAIN" (dijalankan sebelum skrip halaman),
 * sekaligus modul yang dapat dimuat di Service Worker (importScripts),
 * halaman ekstensi (chrome-extension:), dan Node.js (unit test).
 * TIDAK membuat global apa pun di konteks halaman web (stealth).
 *
 * © MIT License — untuk perlindungan privasi pribadi.
 *
 * v3.0.0 — pembaruan menyeluruh end-to-end (lihat CHANGELOG.md):
 *  - BARU: WebGPU (navigator.gpu → GPUAdapterInfo/limits/features dispoof;
 *          teknik selaras Brave 1.93 "GPU fingerprinting protections").
 *  - BARU: Farbling blob Web Worker/SharedWorker — prelude yang dipatch di
 *          dalam lingkup worker (WorkerNavigator.hardwareConcurrency/userAgent,
 *          OffscreenCanvas 2D + WebGL noise dengan tabel seed IDENTIK dengan
 *          thread utama). Menutup bypass worker-scope yang di v2 diakui
 *          sebagai keterbatasan.
 *  - BARU: API perangkat eksternal (hwapi): Bluetooth/USB/HID/Serial getDevices
 *          → kosong, requestDevice → NotFoundError, XR → tidak didukung,
 *          getGamepads → [null×4], getInstalledRelatedApps → [].
 *  - BARU: Guard window.open — popup about:blank dipatch SINKRON sebelum
 *          halaman pembuka sempat membaca nilai asli (menutup race
 *          "fresh pristine window").
 *  - BARU: AudioContext baseLatency/outputLatency dipin ke pool lazim
 *          (profil latensi hardware audio tidak lagi bocor).
 *  - BARU: getSupportedExtensions + getExtension WebGL difarbling deterministik
 *          per-domain (teknik selaras farbling Brave Sept 2026).
 *  - BARU: matchMedia kini menangani kueri resolution/-webkit-device-pixel-ratio
 *          secara KONSISTEN dengan devicePixelRatio spoof (menutup lie-detector
 *          JS-dpr vs media-query); + video-dynamic-range & environment-blending.
 *  - BARU: window.outerWidth/outerHeight dinamis konsisten dengan layar spoof
 *          (menyembunyikan deduksi ukuran layar dari jendela dimaksimalkan);
 *          screen.isExtended → false; getScreenDetails → ditolak;
 *          screenLeft/screenTop → 0.
 *  - BARU: Guard anti-deteksi-blank: noise canvas dilewati untuk piksel
 *          alpha=0 (kanvas kosong tetap kosong — noise tak terdeteksi);
 *          noise audio dilewati untuk sampel nol/128 (silence tetap silence).
 *  - FIX: getHighEntropyValues dengan argumen bukan-array kini melempar
 *         TypeError (v2 mengembalikan objek — lie terdeteksi).
 *  - FIX: mediaCapabilities.decodingInfo dengan argumen tidak valid jatuh ke
 *         fungsi asli (TypeError asli dipertahankan).
 *  - FIX: permission 'local-fonts' tidak pernah 'granted' — konsisten dengan
 *         queryLocalFonts yang selalu ditolak (v2 bisa 'granted' → lie).
 *  - FIX: peta keyboard layout ditambah Space/Backquote/tombol numpad
 *         (v2 hanya 46 tombol — beda jumlah dari peta Chromium asli).
 *  - FIX: navigator.pdfViewerEnabled dipatch true (konsisten plugins standar).
 *  - FIX: DNR kini juga membuang Accept-CH/Critical-CH dari RESPONSE
 *         (server tidak bisa minta opt-in client-hints entropy tinggi).
 *  - Manifest: izin "tabs" DIHAPUS (tanpa peringatan "baca riwayat");
 *         host_permissions tetap menjamin akses URL tab aktif.
 */
(function () {
'use strict';

const KABUT_VERSION = '3.0.0';


/* =====================================================================
 * BAGIAN 1 — UTILITAS MURNI (PRNG ter-seed, hash, helper)
 * ===================================================================== */

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

function rngInt(rng) {
  return Math.floor(rng() * 4294967296) >>> 0;
}

function hash32(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n = n ^ (n >>> 4);
  n = Math.imul(n, 0x27d4eb2d);
  n = n ^ (n >>> 15);
  return n >>> 0;
}

function clamp255(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

function pick(rng, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

function hex8(n) {
  let s = (n >>> 0).toString(16);
  while (s.length < 8) s = '0' + s;
  return s;
}

/** Seed domain deterministik: fungsi dari (secret install, domain). */
function computeDomainSeed(secret, domain) {
  const rng = makeRng('kabut/domain-seed|' + String(secret) + '|' + String(domain));
  return hex8(rngInt(rng)) + hex8(rngInt(rng));
}

function osFamilyFromUA(ua) {
  ua = String(ua || '');
  if (/Windows NT|Win64|WOW64/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  if (/X11|Linux/.test(ua)) return 'linux';
  return 'windows';
}

/** Normalisasi domain allowlist (lowercase, tanpa titik awal). */
function normDomain(d) {
  return String(d || '').toLowerCase().replace(/^\./, '');
}

/** Apakah domain masuk cakupan entri allowlist (exact atau subdomain). */
function domainMatches(entry, domain) {
  const a = normDomain(entry);
  const d = normDomain(domain);
  if (!a || !d) return false;
  return d === a || d.endsWith('.' + a);
}

/** Cari deskriptor properti di objek itu sendiri atau Window.prototype. */
function getDescriptorAny(win, prop) {
  try {
    const own = Object.getOwnPropertyDescriptor(win, prop);
    if (own) return { target: win, desc: own };
    if (win.Window && win.Window.prototype) {
      const d = Object.getOwnPropertyDescriptor(win.Window.prototype, prop);
      if (d) return { target: win.Window.prototype, desc: d };
    }
  } catch (e) {}
  return null;
}

/* ---------------------------------------------------------------------
 * v3-BARU: evaluator murni kueri media resolution — dipakai patch
 * matchMedia agar konsisten dengan devicePixelRatio spoof.
 * Mengembalikan null bila tidak ada klausa resolution, selain itu
 * { ok: boolean } — ok = apakah spoofed dpr memenuhi seluruh klausa.
 * ------------------------------------------------------------------- */
function evalMediaResolution(q, dpr) {
  try {
    q = String(q);
    let touched = false;
    let allOk = true;
    let m;
    const resRe = /(min-|max-)?resolution\s*:\s*([0-9.]+)\s*(dpi|dpcm|dppx|x)?/gi;
    while ((m = resRe.exec(q))) {
      touched = true;
      const v = parseFloat(m[2]);
      const unit = String(m[3] || 'dppx').toLowerCase();
      let dppx = v;
      if (unit === 'dpi') dppx = v / 96;
      else if (unit === 'dpcm') dppx = v / 37.7952755905512;
      const isMin = m[1] === 'min-';
      const isMax = m[1] === 'max-';
      /* Slack 1e-4 menoleransi nilai dpi/dpcm yang dibulatkan halaman
       * (mis. "37.795dpcm" ≈ 1dppx) tanpa membiarkan dpr asli lolos. */
      if (isMin && dpr < dppx - 1e-4) allOk = false;
      else if (isMax && dpr > dppx + 1e-4) allOk = false;
      else if (!isMin && !isMax && Math.abs(dpr - dppx) > 1e-4) allOk = false;
    }
    const wkRe = /-webkit-(min-|max-)?device-pixel-ratio\s*:\s*([0-9.]+)/gi;
    while ((m = wkRe.exec(q))) {
      touched = true;
      const v = parseFloat(m[2]);
      const isMin = m[1] === 'min-';
      const isMax = m[1] === 'max-';
      if (isMin && dpr < v - 1e-9) allOk = false;
      else if (isMax && dpr > v + 1e-9) allOk = false;
      else if (!isMin && !isMax && Math.abs(dpr - v) > 1e-6) allOk = false;
    }
    if (!touched) return null;
    return { ok: allOk };
  } catch (e) { return null; }
}


/* =====================================================================
 * BAGIAN 2 — POOL DATA (nilai lazim/populer → entropy rendah)
 * ===================================================================== */

const SCREEN_POOL = [
  [1920, 1080, 1],
  [1536, 864, 1.25],
  [1366, 768, 1],
  [1440, 900, 1],
  [1600, 900, 1],
  [2560, 1440, 1],
  [1280, 720, 1.25],
  [1680, 1050, 1],
  [2048, 1152, 1.25],
  [1280, 1024, 1]
];

const CORES_POOL = [2, 4, 6, 8, 12, 16, 20, 24];
const MEM_POOL = [2, 4, 8];

const PLATFORM_VERSION_POOLS = {
  windows: ['13.0.0', '14.0.0', '15.0.0'],
  macos: ['10.15.7', '11.7.10', '12.7.4', '13.6.5', '14.4.1', '14.7.1', '15.3.1'],
  linux: ['5.15.0', '6.1.0', '6.5.0', '6.8.0']
};

const GPU_POOLS = {
  windows: [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00009BC8) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' }
  ],
  macos: [
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 645, Unspecified Version)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5300M, Unspecified Version)' }
  ],
  linux: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6 (Core Profile) Mesa 23.2.1)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6 (Core Profile) Mesa 24.0.1)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650/PCIe/SSE2, OpenGL 4.6)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 (POLARIS10, DRM 3.54.0, 6.5.0, LLVM 15.0.7), OpenGL 4.6)' }
  ]
};

const MAX_TEXTURE_POOL = [16384, 32768];
const MAX_VIEWPORT_POOL = [[16384, 16384], [32768, 32768]];

/* Pool sampleRate AudioContext (jam perangkat; nilai lazim). */
const SAMPLE_RATE_POOL = [44100, 48000];

/* v3-BARU: latensi audio perangkat — pool nilai lazim Chrome desktop.
 * baseLatency/outputLatency bergantung hardware/jam audio → fingerprint. */
const AUDIO_BASE_LATENCY_POOL = [0.005, 0.0064, 0.008, 0.0106];
const AUDIO_OUTPUT_LATENCY_POOL = [0.0092, 0.0116, 0.0139, 0.0173];

/* Batas heap JS lazim (Chrome desktop 64-bit). */
const JS_HEAP_LIMIT_POOL = [2197815296, 4294705152];

/* v3-BARU: WebGPU — vendor generik + nilai fallback standar Chromium.
 * GPUAdapterInfo Chrome lazim melaporkan architecture 'common-3d',
 * device & description kosong. */
const WGPU_VENDOR_POOL = ['intel', 'nvidia', 'amd'];

/* v3-BARU: batas WebGPU dispoof ke nilai MINIMUM spesifikasi →
 * dijamin tidak pernah MELEBIHI kemampuan adapter nyata
 * (aman terhadap breakage) dan seragam antar-pengguna. */
const WGPU_LIMITS_SPOOF = {
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 2048,
  maxBufferSize: 268435456,
  maxStorageBufferBindingSize: 134217728
};

/* v3-BARU: fitur WebGPU yang lazim di Chromium desktop. Fitur di luar
 * daftar ini (GPU-spesifik: etc2/astc/subgroups/…) disembunyikan.
 * Filter hanya MENGHAPUS (tak pernah menambah) → situs tidak pernah
 * meminta fitur yang tak didukung → nol risiko breakage. */
const WGPU_COMMON_FEATURES = [
  'depth-clip-control', 'depth32float-stencil8', 'float32-filterable',
  'indirect-first-instance', 'shader-f16', 'texture-compression-bc', 'timestamp-query'
];

/* v3-BARU: ekstensi WebGL yang boleh di-farbling (dibuang per-domain
 * deterministik p=0.5). Ekstensi krusial-render tidak pernah dibuang. */
const WEBGL_EXT_OPTIONAL = [
  'EXT_disjoint_timer_query',
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic',
  'OES_fbo_render_mipmap',
  'OES_texture_float_linear',
  'OES_texture_half_float_linear',
  'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_multi_draw'
];

/* Preset kekuatan noise (amplitudo LSB untuk canvas). */
const CANVAS_AMP = { subtle: 1, medium: 2, strong: 5 };
/* Amplitudo noise audio (magnitudo pada Float32). */
const AUDIO_AMP = { subtle: 3e-8, medium: 1.2e-7, strong: 6e-7 };

/*
 * Permission API — vektor fingerprinting (enumerasi state permission).
 * Nilai per-domain deterministik; nama sensitif difiksasi ke nilai yang
 * lazim & tidak merusak alur UX (prompt), nama eksotis di-seed.
 * 'notifications' tidak pernah 'granted' agar Notification.requestPermission
 * tetap konsisten dan ctor Notification tidak pernah dilempar palsu.
 * v3-FIX: 'local-fonts' tidak pernah 'granted' — konsisten dengan
 * queryLocalFonts yang selalu ditolak NotAllowedError.
 */
const PERM_FIXED = {
  'geolocation': 'prompt',
  'camera': 'prompt',
  'microphone': 'prompt',
  'clipboard-read': 'prompt',
  'clipboard-write': 'granted',
  'persistent-storage': 'granted',
  'background-sync': 'granted',
  'periodic-background-sync': 'granted',
  'local-fonts': 'prompt'
};
const PERM_SEEDABLE = ['notifications', 'midi', 'accelerometer', 'gyroscope',
  'magnetometer', 'screen-wake-lock', 'payment-handler',
  'storage-access', 'window-management', 'idle-detection'];
/* Permission yang diarahkan mengikuti state 'notifications'. */
const PERM_FOLLOW_NOTIF = ['push'];


/* =====================================================================
 * BAGIAN 3 — KONFIGURASI DEFAULT & NORMALISASI
 * (dipakai SW, halaman opsi, dan pengujian)
 * ===================================================================== */

const DEFAULT_CONFIG = {
  v: 3,
  enabled: true,
  preset: 'paranoid',
  profile: 'real',
  webrtc: 'strict',
  headers: 'core',
  surfaces: {
    canvas: 'noise',
    canvasStrength: 'medium',
    webgl: true,
    audio: true,
    rects: true,
    fonts: true,
    screen: true,
    hardware: true,
    memory: true,
    touch: true,
    devices: true,
    battery: true,
    network: true,
    storage: true,
    keyboard: true,
    plugins: true,
    uaData: true,
    media: true,
    voices: true,
    permissions: true,
    webgpu: true,
    hwapi: true,
    workers: true
  },
  allowlist: [],
  domainOverrides: {}
};

function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDeep(base[k], pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

function normalizeSettings(raw) {
  const cfg = mergeDeep(DEFAULT_CONFIG, raw || {});
  cfg.v = 3;
  cfg.profile = ['real', 'windows', 'macos', 'linux'].indexOf(cfg.profile) >= 0 ? cfg.profile : 'real';
  cfg.webrtc = ['strict', 'balanced', 'block', 'off'].indexOf(cfg.webrtc) >= 0 ? cfg.webrtc : 'strict';
  cfg.headers = ['core', 'strict', 'none'].indexOf(cfg.headers) >= 0 ? cfg.headers : 'core';
  cfg.preset = ['paranoid', 'seimbang'].indexOf(cfg.preset) >= 0 ? cfg.preset : 'paranoid';
  const s = cfg.surfaces;
  s.canvas = ['noise', 'block', 'off'].indexOf(s.canvas) >= 0 ? s.canvas : 'noise';
  s.canvasStrength = CANVAS_AMP[s.canvasStrength] !== undefined ? s.canvasStrength : 'medium';
  /* v3: surface baru — boolean; konfigurasi v2 lama otomatis migrasi
   * (mergeDeep mengisi kunci yang hilang dari default). */
  ['webgpu', 'hwapi', 'workers'].forEach(function (k) {
    if (typeof s[k] !== 'boolean') s[k] = true;
  });
  if (s.permissions === undefined) s.permissions = true;
  if (!Array.isArray(cfg.allowlist)) cfg.allowlist = [];
  if (!cfg.domainOverrides || typeof cfg.domainOverrides !== 'object') cfg.domainOverrides = {};
  cfg.allowlist = cfg.allowlist.filter(function (d) {
    return typeof d === 'string' && d.trim() && d.length < 254;
  });
  return cfg;
}

/* =====================================================================
 * BAGIAN 4 — PROFIL UA (transformasi UA asli → anti-penuaan versi)
 * ===================================================================== */

/**
 * Membangun profil perangkat dari UA ASLI pengguna.
 * Strategi: hanya token platform yang diganti (Windows/macOS/Linux),
 * nomor versi Chrome ASLI dipertahankan sehingga konsistensi
 * fitur-deteksi ↔ UA-versi tetap terjaga selamanya.
 */
function buildProfile(realUA, realBrands, profileId) {
  realUA = String(realUA || '');
  profileId = (profileId === 'windows' || profileId === 'macos' || profileId === 'linux') ? profileId : 'real';

  const verM = /Chrome\/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(realUA);
  const major = verM ? String(Math.max(1, parseInt(verM[1], 10) || 120)) : '120';
  const full = verM
    ? (verM[1] + '.' + (verM[2] || '0') + '.' + (verM[3] || '0') + '.' + (verM[4] || '0'))
    : '120.0.0.0';

  const tokens = {
    windows: { paren: 'Windows NT 10.0; Win64; x64', platform: 'Win32', ch: 'Windows' },
    macos: { paren: 'Macintosh; Intel Mac OS X 10_15_7', platform: 'MacIntel', ch: 'macOS' },
    linux: { paren: 'X11; Linux x86_64', platform: 'Linux x86_64', ch: 'Linux' }
  };

  const realFamily = osFamilyFromUA(realUA);
  const fam = profileId === 'real' ? realFamily : profileId;

  let ua = realUA;
  if (profileId !== 'real' && profileId !== realFamily) {
    const tk = tokens[profileId];
    if (/\([^)]*\)\s*AppleWebKit/.test(realUA)) {
      ua = realUA.replace(/\([^)]*\)(?=\s*AppleWebKit)/, tk.paren);
    } else {
      ua = 'Mozilla/5.0 (' + tk.paren + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + full + ' Safari/537.36';
      if (/Edg\//.test(realUA)) ua += ' Edg/' + full;
    }
  }

  let brands = null;
  if (Array.isArray(realBrands) && realBrands.length) {
    brands = realBrands.map(function (b) {
      return { brand: String((b && b.brand) || ''), version: String((b && b.version) || major) };
    });
  }
  if (!brands) {
    brands = [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not_A Brand', version: '8' }
    ];
    if (/Edg\//.test(realUA)) brands.splice(2, 0, { brand: 'Microsoft Edge', version: major });
  }

  return {
    id: profileId,
    isReal: profileId === 'real',
    osFamily: fam,
    ua: ua,
    appVersion: ua.replace(/^Mozilla\//, ''),
    platform: tokens[fam].platform,
    chPlatform: tokens[fam].ch,
    brands: brands,
    mobile: false,
    versionMajor: major,
    versionFull: full
  };
}

/** String header Sec-CH-UA yang konsisten dengan brands profil. */
function buildChUaHeader(profile) {
  return profile.brands.map(function (b) {
    return '"' + b.brand + '";v="' + b.version + '"';
  }).join(', ');
}

/** Nilai client-hints entropy-tinggi (JS getHighEntropyValues) yang konsisten. */
function buildHighEntropy(profile, rng) {
  const pool = PLATFORM_VERSION_POOLS[profile.osFamily] || PLATFORM_VERSION_POOLS.windows;
  const pv = pick(rng, pool);
  const fullVersionList = profile.brands.map(function (b) {
    return {
      brand: b.brand,
      version: /^Not/i.test(b.brand) ? b.version : profile.versionFull
    };
  });
  return {
    architecture: 'x86',
    bitness: '64',
    model: '',
    platformVersion: pv,
    uaFullVersion: profile.versionFull,
    fullVersionList: fullVersionList,
    wow64: false,
    formFactors: ['desktop'],
    mobile: false,
    platform: profile.chPlatform,
    brands: profile.brands.slice()
  };
}


/* =====================================================================
 * BAGIAN 5 — MESIN NOISE DETERMINISTIK
 * Kunci anti-deteksi: nilai noise = fungsi murni (seed, koordinat).
 * Render/readout dua kali → hasil IDENTIK (lolos uji Castle.io),
 * namun beda domain → beda seed → beda sidik jari (anti cross-site).
 * ===================================================================== */

const CANVAS_TABLE_SIZE = 512;

/** Tabel noise canvas dari seed; amplitudo = jumlah LSB. */
function makeCanvasNoiseTable(seedStr, amp) {
  const rng = makeRng('kabut/canvas|' + String(seedStr));
  const t = new Int8Array(CANVAS_TABLE_SIZE);
  for (let i = 0; i < CANVAS_TABLE_SIZE; i++) {
    let v = Math.round((rng() * 2 - 1) * amp);
    if (v === 0) v = rng() < 0.5 ? -1 : 1;
    if (v > amp) v = amp;
    if (v < -amp) v = -amp;
    t[i] = v;
  }
  return t;
}

/** Noise piksel deterministik — fungsi dari (table, x, y, channel). */
function canvasNoiseAt(table, x, y, ch) {
  const h = hash32((Math.imul(x | 0, 73856093)) ^ (Math.imul(y | 0, 19349663)) ^ (Math.imul(ch | 0, 83492791)));
  return table[h & (table.length - 1)];
}

/**
 * Terapkan noise pada ImageData (RGBA).
 * v3-FIX anti-deteksi-blank: piksel dengan alpha === 0 dilewati —
 * kanvas kosong tetap menghasilkan pembacaan (0,0,0,0) persis seperti
 * native, sehingga "probe kanvas kosong" tidak mendeteksi keberadaan
 * noise (v2 men-noise piksel transparan → nilainya ±amp dengan alpha 0).
 */
function noiseImageData(img, table, ox, oy) {
  try {
    const d = img.data;
    const w = img.width || 1;
    const n = (img.height || 1) * w;
    for (let p = 0; p < n; p++) {
      const i = p << 2;
      if (d[i + 3] === 0) continue; // piksel transparan → jangan disentuh
      const x = (ox | 0) + (p % w);
      const y = (oy | 0) + ((p / w) | 0);
      d[i] = clamp255(d[i] + canvasNoiseAt(table, x, y, 0));
      d[i + 1] = clamp255(d[i + 1] + canvasNoiseAt(table, x, y, 1));
      d[i + 2] = clamp255(d[i + 2] + canvasNoiseAt(table, x, y, 2));
    }
  } catch (e) { /* diam: jangan bocorkan keberadaan proteksi */ }
  return img;
}

const AUDIO_TABLE_SIZE = 1024;

/** Tabel noise audio Float32 (±amp) — deterministik per indeks sampel. */
function makeAudioNoiseTable(seedStr, amp) {
  const rng = makeRng('kabut/audio|' + String(seedStr));
  const t = new Float32Array(AUDIO_TABLE_SIZE);
  for (let i = 0; i < AUDIO_TABLE_SIZE; i++) {
    t[i] = (rng() * 2 - 1) * amp;
  }
  return t;
}

function audioNoiseAt(table, i) {
  return table[(i | 0) & (table.length - 1)];
}

/** Tabel noise byte (±1) untuk array getByte*Data. */
function makeByteNoiseTable(seedStr) {
  const rng = makeRng('kabut/audio-byte|' + String(seedStr));
  const t = new Int8Array(AUDIO_TABLE_SIZE);
  for (let i = 0; i < AUDIO_TABLE_SIZE; i++) {
    const v = Math.round((rng() * 2 - 1) * 1.4);
    t[i] = v === 0 ? 1 : v;
  }
  return t;
}

/** Generator jitter persegi deterministik: f(key, idx) ∈ [-0.5, 0.5). */
function makeRectNoise(seedStr) {
  const rng = makeRng('kabut/rect|' + String(seedStr));
  const sub = rngInt(rng);
  return function (key, idx) {
    const h = hash32(Math.imul(key | 0, 2654435761) ^ Math.imul(idx + 1, 40503) ^ sub);
    return h / 4294967296 - 0.5;
  };
}

/** Faktor skala width untuk measureText — per-domain stabil, ±0.06%. */
function makeTextEps(seedStr) {
  const rng = makeRng('kabut/fonts|' + String(seedStr));
  return (rng() * 2 - 1) * 0.0006;
}

/** Permutasi deterministik (Fisher–Yates ter-seed) untuk daftar voice. */
function makePermutation(seedStr, n) {
  const rng = makeRng('kabut/perm|' + String(seedStr));
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  return idx;
}

/* =====================================================================
 * BAGIAN 6 — PEMBANGUN NILAI SPOOF (murni; dipakai core & pengujian)
 * ===================================================================== */

function buildSpoofValues(realEnv, profile, domainSeed) {
  const rng = makeRng('kabut/spoof|' + String(domainSeed) + '|' + profile.osFamily);
  const out = {};

  // Perangkat keras
  out.cores = pick(rng, CORES_POOL);
  out.memory = pick(rng, MEM_POOL);

  // Layar — kandidat harus >= layar CSS asli agar konsisten dengan
  // window.outerWidth (jendela dimaksimalkan tidak boleh melebihi layar).
  const realW = realEnv && realEnv.screenW ? realEnv.screenW : 800;
  const realH = realEnv && realEnv.screenH ? realEnv.screenH : 600;
  const cand = SCREEN_POOL.filter(function (s) { return s[0] >= realW && s[1] >= realH; });
  const sc = cand.length ? pick(rng, cand) : [realW, realH, (realEnv && realEnv.dpr) || 1];
  const taskbar = { windows: 40, macos: 25, linux: 0 }[profile.osFamily] || 0;
  out.screen = {
    width: sc[0],
    height: sc[1],
    availWidth: sc[0],
    availHeight: Math.max(600, sc[1] - taskbar),
    dpr: sc[2],
    colorDepth: 24,
    pixelDepth: 24,
    availLeft: 0,
    availTop: 0
  };

  // GPU
  const gpus = GPU_POOLS[profile.osFamily] || GPU_POOLS.windows;
  const gpu = pick(rng, gpus);
  out.gpu = { vendor: gpu.vendor, renderer: gpu.renderer };
  out.maxTextureSize = pick(rng, MAX_TEXTURE_POOL);
  out.maxViewport = pick(rng, MAX_VIEWPORT_POOL);

  // v3-BARU: WebGPU — vendor generik + fallback standar Chromium.
  out.wgpu = {
    vendor: pick(rng, WGPU_VENDOR_POOL),
    architecture: 'common-3d',
    device: '',
    description: ''
  };

  // v3-BARU: latensi audio perangkat.
  out.audioLat = {
    base: pick(rng, AUDIO_BASE_LATENCY_POOL),
    output: pick(rng, AUDIO_OUTPUT_LATENCY_POOL)
  };

  // Baterai (stabil per-domain) — v2: chargingTime konsisten dgn fake.
  const charging = rng() < 0.3;
  out.battery = {
    level: Math.round((0.15 + rng() * 0.83) * 100) / 100,
    charging: charging,
    dischargingTime: charging ? Infinity : Math.round(3600 * (1 + rng() * 8)),
    chargingTime: charging ? 3600 : Infinity
  };

  // Network Information API
  out.conn = {
    effectiveType: '4g',
    type: 'wifi',
    downlink: pick(rng, [5, 10, 15]),
    rtt: pick(rng, [50, 100, 150]),
    saveData: false
  };

  // Storage quota (navigator.storage.estimate)
  out.quota = pick(rng, [64424509440, 128849018880, 322122547200]);
  out.usage = Math.round(52428800 + rng() * 524288000);

  // Audio hardware clock
  out.sampleRate = pick(rng, SAMPLE_RATE_POOL);

  // Client hints entropy tinggi (JS)
  out.highEntropy = buildHighEntropy(profile, rng);

  return out;
}

/* ---------------------------------------------------------------------
 * Permission map — deterministik per-domain (dipakai applyPermissions).
 * ------------------------------------------------------------------- */
function buildPermissionStates(domainSeed) {
  const rng = makeRng('kabut/perm|' + String(domainSeed));
  const map = {};
  for (const k of Object.keys(PERM_FIXED)) map[k] = PERM_FIXED[k];
  for (let i = 0; i < PERM_SEEDABLE.length; i++) {
    const name = PERM_SEEDABLE[i];
    const r = rng();
    if (name === 'notifications') {
      map[name] = r < 0.55 ? 'prompt' : 'denied'; // tidak pernah granted (lihat 00-head)
    } else {
      map[name] = r < 0.45 ? 'prompt' : (r < 0.9 ? 'granted' : 'denied');
    }
  }
  for (let i = 0; i < PERM_FOLLOW_NOTIF.length; i++) {
    map[PERM_FOLLOW_NOTIF[i]] = map.notifications;
  }
  return map;
}


/* =====================================================================
 * BAGIAN 7 — PERKAKAS STEALTH
 * Anti-deteksi tampering ala CreepJS:
 *  - toString() patch → tampak "[native code]"
 *  - fn.name / fn.length disamakan dengan fungsi asli
 *  - deskriptor properti dicerminkan (enumerable/configurable/writable)
 *  - setiap wrapper try/catch → gagal? jatuh ke fungsi asli
 *    (tidak pernah membiarkan stack chrome-extension:// bocor)
 *
 * makeShim(): instance Proxy di atas Object.create(Interface.prototype)
 *  - getPrototypeOf(instance) === Interface.prototype  ✓
 *  - instanceof Interface / EventTarget                 ✓
 *  - Object.prototype.toString → "[object Interface]"  ✓ (@@toStringTag asli)
 *  - getOwnPropertyNames(instance) → bersih             ✓
 *
 * v3-BARU makeBoundProxy(): Proxy di atas INSTANSI NYATA (bukan objek
 * kosong) untuk objek platform yang punya method native dengan
 * pemeriksaan receiver (WebGPU GPUAdapter/GPUDevice/GPUSupportedLimits/
 * GPUSupportedFeatures): method native di-bound ke instansi asli
 * (panggilan selalu valid — tidak pernah "Illegal invocation"),
 * ter-nativize penuh, dan identitas fungsi stabil (cache).
 * ===================================================================== */

/* WeakMap STRING-NATIVE dibagi satu instansi core (semua kit / semua realm).
   Kunci: wrapper dibuat di realm SKRIP kita, tetapi toString()-nya bisa
   diresolusi lewat Function.prototype realm mana pun yang kita patch
   (mis. window anak via lazy iframe-guard) — map bersama menjamin
   guard di realm mana pun menemukan registrasi wrapper tersebut. */
const NATIVE_STRINGS = new WeakMap();

/** nativize mandiri (dipakai kit & makeShim lintas situasi). */
function nativizeShared(fn, name, len) {
  try { NATIVE_STRINGS.set(fn, 'function ' + name + '() { [native code] }'); } catch (e) {}
  if (typeof name === 'string' && name) {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e) {}
  }
  if (typeof len === 'number') {
    try { Object.defineProperty(fn, 'length', { value: len, configurable: true }); } catch (e) {}
  }
  return fn;
}

function makeStealthKit(win) {

  function nativize(fn, name, len) {
    return nativizeShared(fn, name, len);
  }

  function installToStringGuard() {
    try {
      const proto = win.Function.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'toString');
      if (!desc || typeof desc.value !== 'function') return;
      const orig = desc.value;
      const fake = function toString() {
        const s = NATIVE_STRINGS.get(this);
        if (s !== undefined) return s;
        return orig.call(this);
      };
      nativize(fake, 'toString', 0);
      Object.defineProperty(proto, 'toString', {
        value: fake, writable: true, enumerable: false, configurable: true
      });
    } catch (e) { /* diam */ }
  }

  /** Ganti accessor (getter) pada prototype, cerminkan deskriptor asli. */
  function patchAccessor(obj, prop, getFn) {
    try {
      const d = Object.getOwnPropertyDescriptor(obj, prop);
      if (!d || !d.get) return false;
      nativize(getFn, prop, 0);
      Object.defineProperty(obj, prop, {
        get: getFn,
        set: typeof d.set === 'function' ? d.set : undefined,
        enumerable: d.enumerable,
        configurable: true
      });
      return true;
    } catch (e) { return false; }
  }

  /** Ganti method (value) pada prototype, nativize-kan wrapper. */
  function patchMethod(obj, prop, makeWrapper) {
    try {
      const d = Object.getOwnPropertyDescriptor(obj, prop);
      if (!d || typeof d.value !== 'function') return false;
      const orig = d.value;
      const wrapped = makeWrapper(orig);
      if (typeof wrapped !== 'function') return false;
      nativize(wrapped, (orig && orig.name) || prop, (orig && orig.length) || 0);
      Object.defineProperty(obj, prop, {
        value: wrapped,
        writable: d.writable !== false,
        enumerable: d.enumerable !== false,
        configurable: true
      });
      return true;
    } catch (e) { return false; }
  }

  /** Ganti nilai properti window (mis. RTCPeerConnection). */
  function patchWindowValue(win2, prop, value) {
    try {
      const d = Object.getOwnPropertyDescriptor(win2, prop);
      Object.defineProperty(win2, prop, {
        value: value,
        writable: d ? d.writable !== false : true,
        enumerable: d ? d.enumerable !== false : false,
        configurable: true
      });
      return true;
    } catch (e) { return false; }
  }

  return {
    nativize: nativize,
    installToStringGuard: installToStringGuard,
    patchAccessor: patchAccessor,
    patchMethod: patchMethod,
    patchWindowValue: patchWindowValue
  };
}

/* ---------------------------------------------------------------------
 * makeShim — pabrik instance palsu (Proxy di atas rantai prototipe asli).
 *
 * spec: {
 *   <prop>: <nilai> | { get(t): v } | { get(t): v, set(t, v): bool }
 *          | { method: fn, name: 'fnName', len: 0 }
 * }
 * interfaceCtor: konstruktor interface target (win.BatteryManager, ...).
 * indexItems (opsional): array item untuk akses terindeks (PluginArray dkk.)
 * events (default true): aktifkan addEventListener dst. via EventTarget asli.
 * ------------------------------------------------------------------- */
function makeShim(win, interfaceCtor, spec, opts) {
  opts = opts || {};
  const proto = (interfaceCtor && interfaceCtor.prototype) || Object.prototype;
  const target = Object.create(proto);
  const indexItems = opts.indexItems || null;
  const methodCache = Object.create(null);
  let eventBacking = null;
  let boundEvents = null;
  let proxy = null;

  function resolveMethod(k, def) {
    let fn = methodCache[k];
    if (!fn) {
      fn = def.method;
      nativizeShared(fn, def.name || k, typeof def.len === 'number' ? def.len : (fn.length || 0));
      methodCache[k] = fn;
    }
    return fn;
  }

  function eventBackingEnsure() {
    if (eventBacking) return eventBacking;
    try {
      eventBacking = new win.EventTarget();
      boundEvents = Object.create(null);
    } catch (e) { eventBacking = null; }
    return eventBacking;
  }

  const handler = {
    get: function (t, k, r) {
      try {
        if (k === 'addEventListener' || k === 'removeEventListener' || k === 'dispatchEvent') {
          const eb = eventBackingEnsure();
          if (eb) {
            let fn = boundEvents[k];
            if (!fn) {
              fn = eb[k].bind(eb);
              nativizeShared(fn, k, (eb[k] && eb[k].length) || 0);
              boundEvents[k] = fn;
            }
            return fn;
          }
        }
        if (spec && Object.prototype.hasOwnProperty.call(spec, k)) {
          const def = spec[k];
          if (def && typeof def === 'object') {
            if (typeof def.method === 'function') return resolveMethod(k, def);
            if (typeof def.get === 'function') return def.get(t);
            return undefined;
          }
          return def; // nilai statis
        }
        if (indexItems && typeof k === 'string') {
          const idx = Number(k);
          if (String(idx) === k && idx >= 0 && idx < indexItems.length) {
            return indexItems[idx];
          }
        }
        const v = t[k];
        if (typeof v === 'function' && !(k === 'constructor')) {
          return v;
        }
        return v;
      } catch (e) { return undefined; }
    },
    set: function (t, k, v) {
      try {
        if (spec && Object.prototype.hasOwnProperty.call(spec, k)) {
          const def = spec[k];
          if (def && typeof def === 'object' && typeof def.set === 'function') {
            return def.set(t, v) !== false;
          }
          return false;
        }
        try { t[k] = v; } catch (e) { return false; }
        return true;
      } catch (e) { return false; }
    },
    has: function (t, k) {
      try {
        if (spec && Object.prototype.hasOwnProperty.call(spec, k)) return true;
        if (indexItems && typeof k === 'string') {
          const idx = Number(k);
          if (String(idx) === k && idx >= 0 && idx < indexItems.length) return true;
        }
        return k in t;
      } catch (e) { return false; }
    },
    deleteProperty: function (t, k) {
      try {
        if (spec && Object.prototype.hasOwnProperty.call(spec, k)) return false;
        return delete t[k];
      } catch (e) { return false; }
    },
    ownKeys: function (t) {
      try {
        const keys = Object.getOwnPropertyNames(t);
        if (indexItems) {
          for (let i = 0; i < indexItems.length; i++) {
            if (keys.indexOf(String(i)) < 0) keys.push(String(i));
          }
        }
        return keys;
      } catch (e) { return []; }
    },
    getOwnPropertyDescriptor: function (t, k) {
      try {
        if (indexItems && typeof k === 'string') {
          const idx = Number(k);
          if (String(idx) === k && idx >= 0 && idx < indexItems.length) {
            return {
              value: indexItems[idx], writable: true, enumerable: true, configurable: true
            };
          }
        }
        return Object.getOwnPropertyDescriptor(t, k);
      } catch (e) { return undefined; }
    },
    defineProperty: function (t, k, desc) {
      try {
        if (spec && Object.prototype.hasOwnProperty.call(spec, k)) return false;
        Object.defineProperty(t, k, desc);
        return true;
      } catch (e) { return false; }
    }
  };

  try {
    proxy = new win.Proxy(target, handler);
  } catch (e) {
    proxy = target; // fallback: objek polos (masih berfungsi, kurang stealth)
  }
  return proxy;
}

/* ---------------------------------------------------------------------
 * v3-BARU makeBoundProxy — Proxy di atas INSTANSI NYATA.
 *
 * Dipakai untuk objek platform yang memiliki banyak method native dengan
 * validasi receiver ketat (memanggil dengan this=Proxy melempar
 * "Illegal invocation"). Semua method native di-bound ke target asli,
 * lalu di-nativize (toString/name/length) dan di-cache agar identitas
 * fungsi stabil (a.b.f === a.b.f).
 *
 * overrides: { prop: nilai | {get} | {get,set} | {method,name,len} }
 * ------------------------------------------------------------------- */
function makeBoundProxy(win, real, overrides) {
  overrides = overrides || {};
  const cache = new Map();

  function cached(key, make) {
    let f = cache.get(key);
    if (!f) { f = make(); cache.set(key, f); }
    return f;
  }

  const handler = {
    get: function (t, k) {
      try {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) {
          const def = overrides[k];
          if (def && typeof def === 'object') {
            if (typeof def.method === 'function') {
              return cached('m:' + String(k), function () {
                nativizeShared(def.method, def.name || String(k),
                  typeof def.len === 'number' ? def.len : def.method.length);
                return def.method;
              });
            }
            if (typeof def.get === 'function') return def.get(t);
            if ('value' in def) return def.value;
            return undefined;
          }
          return def; // nilai statis (number/string/bool)
        }
        const v = t[k];
        if (typeof v === 'function') {
          return cached('f:' + String(k), function () {
            const bound = v.bind(t);
            nativizeShared(bound, (v && v.name) || String(k), (v && v.length) || 0);
            return bound;
          });
        }
        return v;
      } catch (e) { return undefined; }
    },
    set: function (t, k, v) {
      try {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) {
          const def = overrides[k];
          if (def && typeof def === 'object' && typeof def.set === 'function') {
            return def.set(t, v) !== false;
          }
          return false; // override read-only
        }
        t[k] = v;
        return true;
      } catch (e) { return false; }
    },
    has: function (t, k) {
      try { return (k in t) || Object.prototype.hasOwnProperty.call(overrides, k); }
      catch (e) { return false; }
    },
    deleteProperty: function (t, k) {
      try {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) return false;
        return delete t[k];
      } catch (e) { return false; }
    }
  };

  try {
    return new win.Proxy(real, handler);
  } catch (e) {
    return real;
  }
}


/* =====================================================================
 * BAGIAN 8 — NAVIGATOR (UA, platform, HW, plugins, keyboard, UAData,
 *             Permissions, Notification, performance.memory)
 * Catatan realm: objek yang diserahkan ke halaman dibuat dengan
 * konstruktor milik realm window target (win.Promise, win.Map, ...)
 * agar instanceof lintas-realm tetap benar (anti-deteksi iframe).
 * ===================================================================== */

function applyNavigator(win, ctx, kit) {
  try {
    const Nav = win.Navigator;
    if (!Nav || !Nav.prototype || !win.navigator) return;
    const prof = ctx.profile;
    const s = ctx.cfg.surfaces;
    const P = Nav.prototype;

    if (!prof.isReal) {
      kit.patchAccessor(P, 'userAgent', function () {
        return ctx.locked('ua', function () { return prof.ua; });
      });
      kit.patchAccessor(P, 'appVersion', function () {
        return ctx.locked('appVersion', function () { return prof.appVersion; });
      });
      kit.patchAccessor(P, 'platform', function () {
        return ctx.locked('platform', function () { return prof.platform; });
      });
    }

    kit.patchAccessor(P, 'webdriver', function () { return false; });

    if (s.hardware) {
      kit.patchAccessor(P, 'hardwareConcurrency', function () {
        return ctx.locked('cores', function () { return ctx.spoof().cores; });
      });
    }
    if (s.memory) {
      kit.patchAccessor(P, 'deviceMemory', function () {
        return ctx.locked('memory', function () { return ctx.spoof().memory; });
      });
    }
    if (s.touch) {
      kit.patchAccessor(P, 'maxTouchPoints', function () { return 0; });
    }

    if (s.plugins) {
      applyPlugins(win, ctx, kit);
      /* v3: konsisten dengan set plugins standar Chromium. */
      const dPdf = Object.getOwnPropertyDescriptor(P, 'pdfViewerEnabled');
      if (dPdf && dPdf.get) kit.patchAccessor(P, 'pdfViewerEnabled', function () { return true; });
    }
    if (s.keyboard) applyKeyboard(win, ctx, kit);
    if (s.uaData) applyUserAgentData(win, ctx, kit);
    if (s.permissions) {
      applyPermissions(win, ctx, kit);
      applyNotification(win, ctx, kit);
    }
    applyPerformanceMemory(win, ctx, kit);
  } catch (e) { /* diam */ }
}

/* ---------- navigator.plugins / mimeTypes (set standar Chromium) ---------- */

function buildStandardPluginsSet(win, ctx) {
  const pluginDefs = [
    ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ['WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format']
  ];
  const mimeDefs = [
    ['application/pdf', 'pdf', 'Portable Document Format'],
    ['text/pdf', 'pdf', 'Portable Document Format']
  ];

  const plugins = [];
  const allMimes = [];

  for (let pi = 0; pi < pluginDefs.length; pi++) {
    const pd = pluginDefs[pi];
    const ownMimes = [];
    for (let mi = 0; mi < mimeDefs.length; mi++) {
      const md = mimeDefs[mi];
      const mime = makeShim(win, win.MimeType, {
        type: md[0],
        suffixes: md[1],
        description: md[2],
        enabledPlugin: { get: function () { return plugin; } }
      });
      ownMimes.push(mime);
      allMimes.push(mime);
    }

    const plugin = makeShim(win, win.Plugin, {
      name: pd[0],
      filename: pd[1],
      description: pd[2],
      length: { get: function () { return ownMimes.length; } },
      item: { method: function (i) { return ownMimes[i] || null; }, name: 'item', len: 1 },
      namedItem: {
        method: function (n) {
          for (let i = 0; i < ownMimes.length; i++) if (ownMimes[i].type === n) return ownMimes[i];
          return null;
        }, name: 'namedItem', len: 1
      }
    }, { indexItems: ownMimes });
    plugins.push(plugin);
  }

  const pluginArray = makeShim(win, win.PluginArray, {
    length: { get: function () { return plugins.length; } },
    item: { method: function (i) { return plugins[i] || null; }, name: 'item', len: 1 },
    namedItem: {
      method: function (n) {
        for (let i = 0; i < plugins.length; i++) if (plugins[i].name === n) return plugins[i];
        return null;
      }, name: 'namedItem', len: 1
    },
    refresh: { method: function () {}, name: 'refresh', len: 0 }
  }, { indexItems: plugins });

  const mimeArray = makeShim(win, win.MimeTypeArray, {
    length: { get: function () { return allMimes.length; } },
    item: { method: function (i) { return allMimes[i] || null; }, name: 'item', len: 1 },
    namedItem: {
      method: function (n) {
        for (let i = 0; i < allMimes.length; i++) if (allMimes[i].type === n) return allMimes[i];
        return null;
      }, name: 'namedItem', len: 1
    },
    refresh: { method: function () {}, name: 'refresh', len: 0 }
  }, { indexItems: allMimes });

  return { plugins: pluginArray, mimeTypes: mimeArray };
}

function applyPlugins(win, ctx, kit) {
  const P = win.Navigator && win.Navigator.prototype;
  if (!P) return;
  const set = ctx.locked('pluginsSet', function () { return buildStandardPluginsSet(win, ctx); });
  kit.patchAccessor(P, 'plugins', function () { return set.plugins; });
  kit.patchAccessor(P, 'mimeTypes', function () { return set.mimeTypes; });
}

/* ---------- navigator.keyboard (layout US standar) ----------
 * v3-FIX: peta diperluas (Space, Backquote, numpad lengkap) agar jumlah
 * tombolnya mendekati peta getLayoutMap Chromium en-US asli
 * (v2 hanya 46 → jumlah berbeda dari populasi asli).
 */
function applyKeyboard(win, ctx, kit) {
  const P = win.Navigator && win.Navigator.prototype;
  if (!P) return;
  const US = {
    Backquote: '`', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
    Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0', Minus: '-',
    Equal: '=', KeyQ: 'q', KeyW: 'w', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y',
    KeyU: 'u', KeyI: 'i', KeyO: 'o', KeyP: 'p', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyF: 'f', KeyG: 'g', KeyH: 'h',
    KeyJ: 'j', KeyK: 'k', KeyL: 'l', Semicolon: ';', Quote: "'", KeyZ: 'z', KeyX: 'x',
    KeyC: 'c', KeyV: 'v', KeyB: 'b', KeyN: 'n', KeyM: 'm', Comma: ',', Period: '.',
    Slash: '/', Space: ' ',
    Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
    Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
    NumpadDecimal: '.', NumpadAdd: '+', NumpadSubtract: '-',
    NumpadMultiply: '*', NumpadDivide: '/', NumpadEqual: '='
  };
  const fake = makeShim(win, win.Keyboard, {
    getLayoutMap: {
      method: function () {
        const m = new win.Map();
        const keys = Object.keys(US);
        for (let i = 0; i < keys.length; i++) m.set(keys[i], US[keys[i]]);
        return win.Promise.resolve(m);
      }, name: 'getLayoutMap', len: 0
    }
  });
  kit.patchAccessor(P, 'keyboard', function () { return fake; });
}

/* ---------- navigator.userAgentData (+ getHighEntropyValues) ---------- */

function applyUserAgentData(win, ctx, kit) {
  const P = win.Navigator && win.Navigator.prototype;
  if (!P) return;
  const prof = ctx.profile;

  const brands = ctx.locked('brands', function () {
    return prof.brands.map(function (b) { return { brand: b.brand, version: b.version }; });
  });

  const uad = makeShim(win, win.NavigatorUAData, {
    brands: { get: function () { return brands; } },
    mobile: { get: function () { return prof.mobile; } },
    platform: { get: function () { return prof.chPlatform; } },
    getHighEntropyValues: {
      method: function (hints) {
        /* v3-FIX: API asli melempar TypeError untuk argumen bukan array —
         * v2 mengembalikan objek (lie mudah dideteksi). */
        if (!Array.isArray(hints)) {
          throw new win.TypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': The provided value is not of type 'array'.");
        }
        const he = ctx.spoof().highEntropy;
        const out = { brands: brands, mobile: prof.mobile, platform: prof.chPlatform };
        const keys = ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion',
          'fullVersionList', 'wow64', 'formFactors'];
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (hints.indexOf(k) >= 0) out[k] = he[k];
        }
        return win.Promise.resolve(out);
      }, name: 'getHighEntropyValues', len: 1
    },
    toJSON: {
      method: function () {
        return { brands: brands, mobile: prof.mobile, platform: prof.chPlatform };
      }, name: 'toJSON', len: 0
    }
  });
  kit.patchAccessor(P, 'userAgentData', function () { return uad; });
}

/* ---------- Permissions API ---------- */
function applyPermissions(win, ctx, kit) {
  try {
    const Perm = win.Permissions && win.Permissions.prototype;
    if (!Perm || typeof Perm.query !== 'function') return;
    const states = ctx.locked('permStates', function () {
      return buildPermissionStates(ctx.seed + '|perm|' + ctx.domain);
    });

    function statusFor(name) {
      const state = states[name];
      if (!state) return null;
      let onchangeVal = null;
      const wm = new WeakMap();
      const shim = makeShim(win, win.PermissionStatus, {
        state: { get: function () { return state; } },
        name: { get: function () { return name; } },
        onchange: {
          get: function (t) { return wm.get(t) || null; },
          set: function (t, v) { wm.set(t, typeof v === 'function' ? v : null); return true; }
        }
      });
      return shim;
    }

    kit.patchMethod(Perm, 'query', function (orig) {
      return function query(desc) {
        try {
          const name = desc && desc.name;
          if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(states, name)) {
            return win.Promise.resolve(statusFor(name));
          }
        } catch (e) { /* jatuh ke asli */ }
        return orig.apply(this, arguments);
      };
    });
  } catch (e) { /* diam */ }
}

function applyNotification(win, ctx, kit) {
  try {
    const N = win.Notification;
    if (!N) return;
    const states = ctx.locked('permStates', function () {
      return buildPermissionStates(ctx.seed + '|perm|' + ctx.domain);
    });
    const val = states['notifications'] || 'prompt';

    const d = Object.getOwnPropertyDescriptor(N, 'permission');
    if (d && d.get) {
      const getter = function permission() { return val; };
      kit.nativize(getter, 'permission', 0);
      try {
        Object.defineProperty(N, 'permission', {
          get: getter, enumerable: d.enumerable !== false, configurable: true
        });
      } catch (e) {}
    }

    if (typeof N.requestPermission === 'function') {
      kit.patchMethod(N, 'requestPermission', function (orig) {
        return function requestPermission(cb) {
          try {
            if (typeof cb === 'function') cb(val);
            return win.Promise.resolve(val);
          } catch (e) { /* fallback */ }
          return orig.apply(this, arguments);
        };
      });
    }
  } catch (e) { /* diam */ }
}

/* ---------- performance.memory ---------- */
function applyPerformanceMemory(win, ctx, kit) {
  try {
    if (!win.performance) return;
    const perf = win.performance;
    let obj = null;
    let d = Object.getOwnPropertyDescriptor(perf, 'memory');
    if (d && d.get) obj = perf;
    else {
      const PerfP = win.Performance && win.Performance.prototype;
      if (PerfP) {
        const dp = Object.getOwnPropertyDescriptor(PerfP, 'memory');
        if (dp && dp.get) { obj = PerfP; d = dp; }
      }
    }
    if (!obj) return;

    const spoofed = ctx.locked('heapLimit', function () {
      return pick(makeRng('kabut/heap|' + ctx.seed + '|' + ctx.domain), JS_HEAP_LIMIT_POOL);
    });

    const getter = function memory() {
      try {
        const real = d.get.call(this);
        if (!real || typeof real !== 'object') return real;
        return {
          jsHeapSizeLimit: spoofed,
          totalJSHeapSize: real.totalJSHeapSize,
          usedJSHeapSize: real.usedJSHeapSize
        };
      } catch (e) { return undefined; }
    };
    kit.nativize(getter, 'memory', 0);
    Object.defineProperty(obj, 'memory', {
      get: getter,
      set: typeof d.set === 'function' ? d.set : undefined,
      enumerable: d.enumerable,
      configurable: true
    });
  } catch (e) { /* diam */ }
}


/* =====================================================================
 * BAGIAN 9 — SCREEN, devicePixelRatio, orientasi, dimensi jendela
 * Pool resolusi lazim; kandidat hanya boleh >= dimensi CSS asli agar
 * window.outerWidth (jendela maksimal) tidak melampaui screen spoof.
 *
 * v3-BARU:
 *  - outerWidth/outerHeight dinamis: delta jendela-asli dipertahankan
 *    terhadap layar spoof → situs tidak bisa mendeduksi ukuran layar
 *    NYATA dari jendela dimaksimalkan (v2 membocorkan lebar asli).
 *  - screenLeft/screenTop → 0 (alias screenX/Y yang lupa di v2).
 *  - screen.isExtended → false (probe multi-monitor).
 *  - window.getScreenDetails() → NotAllowedError (API Window Management
 *    mengenumerasi seluruh monitor — diblokir sebelum izin).
 * ===================================================================== */

function applyScreen(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.screen) return;
    const Sc = win.Screen;
    const scr = function () { return ctx.spoof().screen; };

    if (Sc && Sc.prototype) {
      const P = Sc.prototype;
      kit.patchAccessor(P, 'width', function () { return ctx.locked('screen.width', function () { return scr().width; }); });
      kit.patchAccessor(P, 'height', function () { return ctx.locked('screen.height', function () { return scr().height; }); });
      kit.patchAccessor(P, 'availWidth', function () { return ctx.locked('screen.availWidth', function () { return scr().availWidth; }); });
      kit.patchAccessor(P, 'availHeight', function () { return ctx.locked('screen.availHeight', function () { return scr().availHeight; }); });
      kit.patchAccessor(P, 'colorDepth', function () { return ctx.locked('screen.colorDepth', function () { return scr().colorDepth; }); });
      kit.patchAccessor(P, 'pixelDepth', function () { return ctx.locked('screen.pixelDepth', function () { return scr().pixelDepth; }); });
      kit.patchAccessor(P, 'availLeft', function () { return 0; });
      kit.patchAccessor(P, 'availTop', function () { return 0; });
      /* v3: probe multi-monitor. */
      const dExt = Object.getOwnPropertyDescriptor(P, 'isExtended');
      if (dExt && dExt.get) kit.patchAccessor(P, 'isExtended', function () { return false; });
    }

    /* screen.orientation — semua kandidat pool landscape. */
    try {
      const so = win.screen && win.screen.orientation;
      const SO = win.ScreenOrientation && win.ScreenOrientation.prototype;
      if (SO) {
        kit.patchAccessor(SO, 'type', function () { return 'landscape-primary'; });
        kit.patchAccessor(SO, 'angle', function () { return 0; });
      } else if (so && typeof so === 'object') {
        try {
          Object.defineProperty(so, 'type', { get: function () { return 'landscape-primary'; }, configurable: true });
          Object.defineProperty(so, 'angle', { get: function () { return 0; }, configurable: true });
        } catch (e) {}
      }
    } catch (e) { /* diam */ }

    // devicePixelRatio: bisa own-property window atau di Window.prototype.
    let dTarget = null;
    const dOwn = Object.getOwnPropertyDescriptor(win, 'devicePixelRatio');
    if (dOwn && dOwn.get) dTarget = win;
    else if (win.Window && win.Window.prototype) {
      const dP = Object.getOwnPropertyDescriptor(win.Window.prototype, 'devicePixelRatio');
      if (dP && dP.get) dTarget = win.Window.prototype;
    }
    if (dTarget) {
      kit.patchAccessor(dTarget, 'devicePixelRatio', function () {
        return ctx.locked('dpr', function () { return scr().dpr; });
      });
    }

    /* Posisi & dimensi jendela (bocor multi-monitor / deduksi layar). */
    const posProps = ['screenX', 'screenY', 'screenLeft', 'screenTop'];
    for (let i = 0; i < posProps.length; i++) {
      const prop = posProps[i];
      const found = getDescriptorAny(win, prop);
      if (found && found.desc.get) kit.patchAccessor(found.target, prop, function () { return 0; });
    }

    /* v3: outerWidth/outerHeight dinamis konsisten layar spoof. */
    const owFound = getDescriptorAny(win, 'outerWidth');
    const ohFound = getDescriptorAny(win, 'outerHeight');
    if (owFound && owFound.desc.get) {
      const origOW = owFound.desc.get;
      const realW = ctx.real.screenW || 800;
      kit.patchAccessor(owFound.target, 'outerWidth', function () {
        try {
          const sp = scr();
          const realOuter = origOW.call(this);
          let v = sp.width - (realW - realOuter);
          let inner = 0;
          try { inner = this.innerWidth || 0; } catch (e) { inner = 0; }
          if (v < inner) v = Math.min(Math.max(inner, 1), sp.width);
          if (!(v > 0) || !isFinite(v)) v = sp.width;
          if (v > sp.width) v = sp.width;
          return v;
        } catch (e) { return origOW.call(this); }
      });
    }
    if (ohFound && ohFound.desc.get) {
      const origOH = ohFound.desc.get;
      const realH = ctx.real.screenH || 600;
      kit.patchAccessor(ohFound.target, 'outerHeight', function () {
        try {
          const sp = scr();
          const realOuter = origOH.call(this);
          let v = sp.height - (realH - realOuter);
          let inner = 0;
          try { inner = this.innerHeight || 0; } catch (e) { inner = 0; }
          if (v < inner) v = Math.min(Math.max(inner, 1), sp.height);
          if (!(v > 0) || !isFinite(v)) v = sp.height;
          if (v > sp.height) v = sp.height;
          return v;
        } catch (e) { return origOH.call(this); }
      });
    }

    /* v3: Window Management API — tolak seolah izin ditolak. */
    if (typeof win.getScreenDetails === 'function') {
      kit.patchWindowValue(win, 'getScreenDetails', function getScreenDetails() {
        return win.Promise.reject(new win.DOMException('Permission denied.', 'NotAllowedError'));
      });
    }
  } catch (e) { /* diam */ }
}

/* =====================================================================
 * BAGIAN 10 — CANVAS 2D (toDataURL / toBlob / getImageData / Offscreen)
 * Noise deterministik per-domain; path toDataURL & getImageData memakai
 * tabel seed yang sama → hasil konsisten lintas jalur pembacaan.
 * v3: piksel alpha=0 tidak di-noise (anti deteksi-blank).
 * ===================================================================== */

function applyCanvas(win, ctx, kit) {
  try {
    const s = ctx.cfg.surfaces;
    if (s.canvas === 'off') return;

    const HC = win.HTMLCanvasElement;
    const CR2D = win.CanvasRenderingContext2D;
    const OC = win.OffscreenCanvas;
    const OC2D = win.OffscreenCanvasRenderingContext2D;

    // Referensi asli harus ditangkap SEBELUM patch (dipakai internal).
    const origGetImageData2D = (CR2D && CR2D.prototype && CR2D.prototype.getImageData) || null;
    const origGetImageDataOC = (OC2D && OC2D.prototype && OC2D.prototype.getImageData) || null;

    /* Mode dibaca DINAMIS dari konfigurasi live (ctx.cfg diganti saat
     * pembaruan bridge) → saklar noise/blok/off dari popup berlaku SEGERA. */
    const mode = function () {
      try {
        const m = ctx.cfg && ctx.cfg.surfaces && ctx.cfg.surfaces.canvas;
        return (m === 'block' || m === 'off') ? m : 'noise';
      } catch (e) { return 'noise'; }
    };

    const noiseTable = function () {
      return ctx.locked('canvasTable', function () {
        const amp = CANVAS_AMP[ctx.cfg.surfaces.canvasStrength] !== undefined
          ? CANVAS_AMP[ctx.cfg.surfaces.canvasStrength] : 2;
        return makeCanvasNoiseTable(ctx.seed + '|canvas|' + ctx.domain, amp);
      });
    };

    /* Salinan canvas yang sudah diberi noise (canvas asli tak diubah). */
    function noisy2DCopy(src) {
      try {
        if (!src || typeof src.width !== 'number' || src.width <= 0 || src.height <= 0) return null;
        const c = win.document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        const c2d = c.getContext('2d');
        if (!c2d) return null;
        c2d.drawImage(src, 0, 0);
        if (origGetImageData2D) {
          const img = origGetImageData2D.call(c2d, 0, 0, c.width, c.height);
          noiseImageData(img, noiseTable(), 0, 0);
          c2d.putImageData(img, 0, 0);
        }
        return c;
      } catch (e) { return null; }
    }

    function blank2DCopy(src) {
      try {
        if (!src || typeof src.width !== 'number' || src.width <= 0) return null;
        const c = win.document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        const c2d = c.getContext('2d');
        if (!c2d) return null;
        c2d.clearRect(0, 0, c.width, c.height);
        return c;
      } catch (e) { return null; }
    }

    function makeCopy(src) {
      const m = mode();
      if (m === 'off') return null;              // nonaktif → jalur asli
      return m === 'block' ? blank2DCopy(src) : noisy2DCopy(src);
    }

    if (HC && HC.prototype) {
      kit.patchMethod(HC.prototype, 'toDataURL', function (orig) {
        return function toDataURL() {
          try {
            if (mode() !== 'off') {
              const c = makeCopy(this);
              if (c) return orig.apply(c, arguments);
            }
          } catch (e) { /* jatuh ke asli */ }
          return orig.apply(this, arguments);
        };
      });
      kit.patchMethod(HC.prototype, 'toBlob', function (orig) {
        return function toBlob() {
          try {
            if (mode() !== 'off') {
              const c = makeCopy(this);
              if (c) return orig.apply(c, arguments);
            }
          } catch (e) { /* jatuh ke asli */ }
          return orig.apply(this, arguments);
        };
      });
    }

    const readNoise = function (img, ox, oy) {
      const m = mode();
      if (m === 'off') return img;
      if (m === 'block') {
        try {
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; }
        } catch (e) {}
        return img;
      }
      return noiseImageData(img, noiseTable(), ox, oy);
    };

    if (CR2D && CR2D.prototype && origGetImageData2D) {
      kit.patchMethod(CR2D.prototype, 'getImageData', function (orig) {
        return function getImageData(sx, sy, sw, sh) {
          const img = orig.apply(this, arguments);
          try { readNoise(img, Number(sx) || 0, Number(sy) || 0); } catch (e) {}
          return img;
        };
      });
    }

    if (OC && OC.prototype) {
      kit.patchMethod(OC.prototype, 'convertToBlob', function (orig) {
        return function convertToBlob() {
          try {
            const m = mode();
            if (m !== 'off' && this && this.width > 0 && origGetImageDataOC) {
              const oc = new win.OffscreenCanvas(this.width, this.height);
              const c2d = oc.getContext('2d');
              if (c2d) {
                c2d.drawImage(this, 0, 0);
                const img = origGetImageDataOC.call(c2d, 0, 0, oc.width, oc.height);
                if (m === 'block') {
                  const d = img.data;
                  for (let i = 0; i < d.length; i += 4) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; }
                } else {
                  noiseImageData(img, noiseTable(), 0, 0);
                }
                c2d.putImageData(img, 0, 0);
                return orig.apply(oc, arguments);
              }
            }
          } catch (e) { /* jatuh ke asli */ }
          return orig.apply(this, arguments);
        };
      });
    }

    if (OC2D && OC2D.prototype && origGetImageDataOC) {
      kit.patchMethod(OC2D.prototype, 'getImageData', function (orig) {
        return function getImageData(sx, sy, sw, sh) {
          const img = orig.apply(this, arguments);
          try { readNoise(img, Number(sx) || 0, Number(sy) || 0); } catch (e) {}
          return img;
        };
      });
    }
  } catch (e) { /* diam */ }
}


/* =====================================================================
 * BAGIAN 11 — WEBGL (vendor/renderer GPU pool, readPixels noise,
 *              farbling daftar ekstensi)
 * GPU pool dipilih sesuai family OS profil agar konsisten dengan UA.
 * v3-BARU: getSupportedExtensions + getExtension difarbling deterministik
 * per-domain (subset dari ekstensi opsional dibuang p=0.5; ekstensi
 * krusial-render selalu dipertahankan) — teknik selaras Brave 2026.
 * ===================================================================== */

function applyWebGL(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.webgl) return;

    const targets = [];
    if (win.WebGLRenderingContext && win.WebGLRenderingContext.prototype) {
      targets.push(win.WebGLRenderingContext.prototype);
    }
    if (win.WebGL2RenderingContext && win.WebGL2RenderingContext.prototype) {
      targets.push(win.WebGL2RenderingContext.prototype);
    }
    if (!targets.length) return;

    const GL_PARAMS = function () {
      return ctx.locked('webglParams', function () {
        const sp = ctx.spoof();
        return {
          37445: sp.gpu.vendor,        // UNMASKED_VENDOR_WEBGL
          37446: sp.gpu.renderer,      // UNMASKED_RENDERER_WEBGL
          3379: sp.maxTextureSize,     // MAX_TEXTURE_SIZE
          34024: sp.maxTextureSize,    // MAX_RENDERBUFFER_SIZE
          3386: [sp.maxViewport[0], sp.maxViewport[1]] // MAX_VIEWPORT_DIMS
        };
      });
    };

    const readTable = function () {
      return ctx.locked('webglReadTable', function () {
        return makeCanvasNoiseTable(ctx.seed + '|glread|' + ctx.domain, 1);
      });
    };

    /* v3: daftar ekstensi yang dibuang — deterministik per-domain. */
    const extDrop = function () {
      return ctx.locked('webglExtDrop', function () {
        const rng = makeRng('kabut/glext|' + ctx.seed + '|' + ctx.domain);
        const drop = Object.create(null);
        for (let i = 0; i < WEBGL_EXT_OPTIONAL.length; i++) {
          drop[WEBGL_EXT_OPTIONAL[i]] = rng() < 0.5;
        }
        return drop;
      });
    };

    for (let t = 0; t < targets.length; t++) {
      const T = targets[t];

      kit.patchMethod(T, 'getParameter', function (orig) {
        return function getParameter(pname) {
          try {
            const p = GL_PARAMS();
            if (Object.prototype.hasOwnProperty.call(p, pname)) {
              const v = p[pname];
              if (pname === 3386) return new win.Int32Array([v[0], v[1]]);
              return v;
            }
          } catch (e) { /* jatuh ke asli */ }
          return orig.apply(this, arguments);
        };
      });

      kit.patchMethod(T, 'readPixels', function (orig) {
        return function readPixels(x, y, w, h, format, type, pixels) {
          const r = orig.apply(this, arguments);
          try {
            const isU8 = pixels && pixels instanceof win.Uint8Array;
            if (isU8 && (format === 6408 || format === 6407)) {
              const stride = format === 6408 ? 4 : 3;
              const tab = readTable();
              const ww = (w && w > 0) ? w : 1;
              for (let i = 0; i < pixels.length; i++) {
                const ch = i % stride;
                if (stride === 4 && ch === 3) continue; // alpha utuh
                if (stride === 4 && pixels[i - ch + 3] === 0) continue; // v3: alpha=0 → skip
                const pix = (i / stride) | 0;
                pixels[i] = clamp255(pixels[i] + canvasNoiseAt(tab, (x | 0) + (pix % ww), (y | 0) + ((pix / ww) | 0), ch));
              }
            }
          } catch (e) { /* diam */ }
          return r;
        };
      });

      /* v3: farbling daftar ekstensi. */
      kit.patchMethod(T, 'getSupportedExtensions', function (orig) {
        return function getSupportedExtensions() {
          const exts = orig.apply(this, arguments);
          try {
            if (!Array.isArray(exts) || !exts.length) return exts;
            const drop = extDrop();
            return exts.filter(function (e) { return !drop[e]; });
          } catch (e) { return exts; }
        };
      });

      kit.patchMethod(T, 'getExtension', function (orig) {
        return function getExtension(name) {
          try {
            if (typeof name === 'string' && extDrop()[name]) return null;
          } catch (e) { /* jatuh ke asli */ }
          return orig.apply(this, arguments);
        };
      });
    }
  } catch (e) { /* diam */ }
}

/* =====================================================================
 * BAGIAN 12 — WEBAUDIO (AudioBuffer + AnalyserNode + properti context)
 * Noise sekali-per-buffer (in-place, ±1e-7, tak terdengar) via WeakSet;
 * AnalyserNode: noise deterministik per indeks (hasil re-read identik).
 *
 * v3-BARU:
 *  - Guard silence: sampel bernilai persis 0 (float) / 0|128 (byte)
 *    TIDAK di-noise → buffer/analizer hening tetap hening persis native
 *    (probe "deteksi noise via silence" gagal mendeteksi proteksi).
 *  - AudioContext.baseLatency & outputLatency dipin ke pool lazim —
 *    profil latensi hardware audio tidak lagi bocor.
 * ===================================================================== */

function applyAudio(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.audio) return;

    const amp = AUDIO_AMP[ctx.cfg.surfaces.canvasStrength] !== undefined
      ? AUDIO_AMP[ctx.cfg.surfaces.canvasStrength] : 1.2e-7;

    const floatTable = function () {
      return ctx.locked('audioTable', function () {
        return makeAudioNoiseTable(ctx.seed + '|audio|' + ctx.domain, amp);
      });
    };
    const byteTable = function () {
      return ctx.locked('audioByteTable', function () {
        return makeByteNoiseTable(ctx.seed + '|audiobyte|' + ctx.domain);
      });
    };

    const AB = win.AudioBuffer;
    if (AB && AB.prototype) {
      const origGCD = AB.prototype.getChannelData;
      const noisedBuffers = new WeakSet();

      function ensureNoised(buf) {
        try {
          if (noisedBuffers.has(buf)) return;
          noisedBuffers.add(buf);
          const n = buf.numberOfChannels || 0;
          const tab = floatTable();
          for (let c = 0; c < n; c++) {
            const arr = origGCD.call(buf, c);
            for (let i = 0; i < arr.length; i++) {
              if (arr[i] === 0) continue; // v3: silence tetap hening
              arr[i] = arr[i] + audioNoiseAt(tab, i);
            }
          }
        } catch (e) { /* diam */ }
      }

      kit.patchMethod(AB.prototype, 'getChannelData', function (orig) {
        return function getChannelData(ch) {
          const arr = orig.apply(this, arguments);
          try { ensureNoised(this); } catch (e) {}
          return arr;
        };
      });

      kit.patchMethod(AB.prototype, 'copyFromChannel', function (orig) {
        return function copyFromChannel() {
          try { ensureNoised(this); } catch (e) {}
          return orig.apply(this, arguments);
        };
      });

      if (typeof AB.prototype.copyToChannel === 'function') {
        kit.patchMethod(AB.prototype, 'copyToChannel', function (orig) {
          return function copyToChannel() {
            const r = orig.apply(this, arguments);
            try { noisedBuffers.delete(this); } catch (e) {}
            return r;
          };
        });
      }
    }

    const AN = win.AnalyserNode;
    if (AN && AN.prototype) {
      const floatFns = ['getFloatFrequencyData', 'getFloatTimeDomainData'];
      for (let i = 0; i < floatFns.length; i++) {
        const fname = floatFns[i];
        kit.patchMethod(AN.prototype, fname, function (orig) {
          return function (arr) {
            const r = orig.apply(this, arguments);
            try {
              const tab = floatTable();
              for (let k = 0; k < arr.length; k++) {
                if (arr[k] === 0) continue; // v3: silence tetap hening
                arr[k] = arr[k] + audioNoiseAt(tab, k);
              }
            } catch (e) {}
            return r;
          };
        });
      }
      const byteFns = ['getByteFrequencyData', 'getByteTimeDomainData'];
      for (let i = 0; i < byteFns.length; i++) {
        const fname = byteFns[i];
        kit.patchMethod(AN.prototype, fname, function (orig) {
          return function (arr) {
            const r = orig.apply(this, arguments);
            try {
              const tab = byteTable();
              for (let k = 0; k < arr.length; k++) {
                if (arr[k] === 0 || arr[k] === 128) continue; // v3: silence (0 freq / 128 time)
                arr[k] = clamp255(arr[k] + audioNoiseAt(tab, k));
              }
            } catch (e) {}
            return r;
          };
        });
      }
    }

    /* sampleRate: hanya AudioContext (jam perangkat) yang diburamkan;
     * OfflineAudioContext tetap jujur terhadap argumen konstruksinya. */
    try {
      const BAC = win.BaseAudioContext && win.BaseAudioContext.prototype;
      const OAC = win.OfflineAudioContext;
      if (BAC && BAC.sampleRate && OAC) {
        const d = Object.getOwnPropertyDescriptor(BAC, 'sampleRate');
        if (d && d.get) {
          const origGet = d.get;
          const fakeRate = ctx.locked('audioRate', function () {
            return ctx.spoof().sampleRate;
          });
          const getter = function sampleRate() {
            try {
              if (this instanceof OAC) return origGet.call(this); // jujur utk Offline
            } catch (e) {}
            return fakeRate; // AudioContext (jam perangkat) → nilai spoof
          };
          kit.nativize(getter, 'sampleRate', 0);
          Object.defineProperty(BAC, 'sampleRate', {
            get: getter,
            set: typeof d.set === 'function' ? d.set : undefined,
            enumerable: d.enumerable,
            configurable: true
          });
        }
      }
    } catch (e) { /* diam */ }

    /* maxChannelCount → 2. */
    try {
      const ADN = win.AudioDestinationNode && win.AudioDestinationNode.prototype;
      if (ADN) {
        const d = Object.getOwnPropertyDescriptor(ADN, 'maxChannelCount');
        if (d && d.get) {
          const getter = function maxChannelCount() { return 2; };
          kit.nativize(getter, 'maxChannelCount', 0);
          Object.defineProperty(ADN, 'maxChannelCount', {
            get: getter,
            set: typeof d.set === 'function' ? d.set : undefined,
            enumerable: d.enumerable,
            configurable: true
          });
        }
      }
    } catch (e) { /* diam */ }

    /* v3: baseLatency/outputLatency — atribut AudioContext (bukan Offline). */
    try {
      const AC = win.AudioContext && win.AudioContext.prototype;
      if (AC) {
        const lat = ctx.locked('audioLat', function () { return ctx.spoof().audioLat; });
        const props = [
          ['baseLatency', function () { return lat.base; }],
          ['outputLatency', function () { return lat.output; }]
        ];
        for (let i = 0; i < props.length; i++) {
          const propName = props[i][0];
          const valFn = props[i][1];
          const d = Object.getOwnPropertyDescriptor(AC, propName);
          if (d && d.get) {
            const getter = function () { return valFn(); };
            kit.nativize(getter, propName, 0);
            Object.defineProperty(AC, propName, {
              get: getter,
              set: typeof d.set === 'function' ? d.set : undefined,
              enumerable: d.enumerable,
              configurable: true
            });
          }
        }
      }
    } catch (e) { /* diam */ }
  } catch (e) { /* diam */ }
}


/* =====================================================================
 * BAGIAN 13 — CLIENTRECTS, FONT METRICS
 *  - Rects: jitter sub-piksel deterministik per-elemen (±0.1%)
 *  - measureText: skala width per-domain (Proxy — instanceof terjaga)
 * ===================================================================== */

function applyRects(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.rects) return;
    const rn = ctx.locked('rectNoise', function () {
      return makeRectNoise(ctx.seed + '|rect|' + ctx.domain);
    });
    const elemIds = new WeakMap();
    let nextId = 1;
    function idOf(el) {
      let v;
      try { v = elemIds.get(el); } catch (e) { v = undefined; }
      if (v === undefined) {
        v = nextId;
        nextId = (nextId + 1) | 0;
        try { elemIds.set(el, v); } catch (e) {}
      }
      return v;
    }
    const MAXREL = 0.001;

    function noisyDomRect(r, key, idx) {
      try {
        if (!r || typeof r.x !== 'number') return r;
        const jx = rn(key, idx * 4) * 2 * MAXREL * (r.width || 1);
        const jy = rn(key, idx * 4 + 1) * 2 * MAXREL * (r.height || 1);
        const jw = rn(key, idx * 4 + 2) * 2 * 0.0008 * (r.width || 1);
        const jh = rn(key, idx * 4 + 3) * 2 * 0.0008 * (r.height || 1);
        return new win.DOMRect(r.x + jx, r.y + jy, (r.width || 0) + jw, (r.height || 0) + jh);
      } catch (e) { return r; }
    }

    function makeRectListShim(list, key) {
      const rects = [];
      const n = list ? list.length : 0;
      for (let i = 0; i < n; i++) rects.push(noisyDomRect(list[i], key, i));
      const itemFn = function item(i) { return rects[i] || null; };
      kit.nativize(itemFn, 'item', 1);
      const shim = { length: n };
      for (let i = 0; i < n; i++) shim[i] = rects[i];
      shim.item = itemFn;
      try {
        if (win.DOMRectList && win.DOMRectList.prototype) {
          Object.setPrototypeOf(shim, win.DOMRectList.prototype);
        }
      } catch (e) {}
      return shim;
    }

    if (win.Element && win.Element.prototype) {
      const EP = win.Element.prototype;
      kit.patchMethod(EP, 'getBoundingClientRect', function (orig) {
        return function getBoundingClientRect() {
          const r = orig.apply(this, arguments);
          return noisyDomRect(r, idOf(this), 0);
        };
      });
      kit.patchMethod(EP, 'getClientRects', function (orig) {
        return function getClientRects() {
          const list = orig.apply(this, arguments);
          return makeRectListShim(list, idOf(this));
        };
      });
    }
    if (win.Range && win.Range.prototype) {
      const RP = win.Range.prototype;
      if (RP.getBoundingClientRect) {
        kit.patchMethod(RP, 'getBoundingClientRect', function (orig) {
          return function getBoundingClientRect() {
            const r = orig.apply(this, arguments);
            return noisyDomRect(r, 900001, 0);
          };
        });
      }
      if (RP.getClientRects) {
        kit.patchMethod(RP, 'getClientRects', function (orig) {
          return function getClientRects() {
            const list = orig.apply(this, arguments);
            return makeRectListShim(list, 900002);
          };
        });
      }
    }
  } catch (e) { /* diam */ }
}

function applyFonts(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.fonts) return;
    const eps = ctx.locked('textEps', function () {
      return makeTextEps(ctx.seed + '|font|' + ctx.domain);
    });
    const SCALE_KEYS = {
      width: 1, actualBoundingBoxLeft: 1, actualBoundingBoxRight: 1,
      actualBoundingBoxAscent: 1, actualBoundingBoxDescent: 1,
      fontBoundingBoxAscent: 1, fontBoundingBoxDescent: 1,
      fontBoundingBoxLeft: 1, fontBoundingBoxRight: 1,
      emHeightAscent: 1, emHeightDescent: 1,
      alphabeticBaseline: 1, hangingBaseline: 1, ideographicBaseline: 1
    };
    function wrapMetrics(tm) {
      if (!tm) return tm;
      try {
        return new win.Proxy(tm, {
          get: function (t, k) {
            const v = t[k];
            if (typeof v === 'number' && Object.prototype.hasOwnProperty.call(SCALE_KEYS, k)) {
              return v * (1 + eps);
            }
            return v;
          }
        });
      } catch (e) { return tm; }
    }
    const targets = [];
    if (win.CanvasRenderingContext2D && win.CanvasRenderingContext2D.prototype) {
      targets.push(win.CanvasRenderingContext2D.prototype);
    }
    if (win.OffscreenCanvasRenderingContext2D && win.OffscreenCanvasRenderingContext2D.prototype) {
      targets.push(win.OffscreenCanvasRenderingContext2D.prototype);
    }
    for (let i = 0; i < targets.length; i++) {
      kit.patchMethod(targets[i], 'measureText', function (orig) {
        return function measureText() {
          return wrapMetrics(orig.apply(this, arguments));
        };
      });
    }
    // Local Font Access API → tolak seolah tanpa izin.
    if (typeof win.queryLocalFonts === 'function') {
      kit.patchWindowValue(win, 'queryLocalFonts', function queryLocalFonts() {
        return win.Promise.reject(new win.DOMException('Permission denied.', 'NotAllowedError'));
      });
    }
  } catch (e) { /* diam */ }
}

/* =====================================================================
 * BAGIAN 14 — matchMedia, mediaCapabilities, VOICES
 * Redesain matchMedia (anti "lies detection"):
 *  - Preferensi PENGGUNA (color-scheme, reduced-motion/contrast/transparency,
 *    inverted-colors, forced-colors) → DILAPORKAN ASLI.
 *  - Karakteristik PERANGKAT (pointer, hover, gamut, dynamic-range,
 *    video-dynamic-range, environment-blending) → dinormalisasi lazim.
 * v3-BARU: kueri resolution / -webkit-device-pixel-ratio dievaluasi
 *  terhadap devicePixelRatio SPOOF (konsistensi JS penuh; menutup
 *  lie-detector dpr-vs-matchMedia).
 * v3-FIX: decodingInfo dengan argumen tidak valid jatuh ke asli.
 * ===================================================================== */

function applyMedia(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.media) return;
    /* Fitur perangkat yang dinormalisasi (nilai lazim desktop). */
    const DEV_FEATURES = [
      { re: /any-pointer:\s*(coarse|fine|none)/, val: 'fine' },
      { re: /pointer:\s*(coarse|fine|none)/, val: 'fine' },
      { re: /any-hover:\s*(hover|none)/, val: 'hover' },
      { re: /hover:\s*(hover|none)/, val: 'hover' },
      { re: /color-gamut:\s*(srgb|p3|rec2020)/, val: 'srgb' },
      { re: /dynamic-range:\s*(standard|high)/, val: 'standard' },
      { re: /video-dynamic-range:\s*(standard|high)/, val: 'standard' },
      { re: /environment-blending:\s*(opaque|additive|subtractive)/, val: 'opaque' }
    ];
    function verdict(q) {
      try {
        if (/\bnot\b/i.test(q)) return null; // negasi: passthrough asli (aman)
        /* v3: klausa resolution dievaluasi terhadap dpr spoof. */
        const spoofDpr = ctx.spoof().screen.dpr;
        const res = evalMediaResolution(q, spoofDpr);
        let rest = String(q);
        rest = rest.replace(/-webkit-(min-|max-)?device-pixel-ratio\s*:\s*[0-9.]+/gi, ' ');
        rest = rest.replace(/(min-|max-)?resolution\s*:\s*[0-9.]+\s*(dpi|dpcm|dppx|x)?/gi, ' ');
        let touched = !!res;
        let allOk = !res || res.ok;
        for (let i = 0; i < DEV_FEATURES.length; i++) {
          const m = DEV_FEATURES[i].re.exec(rest);
          if (!m) continue;
          touched = true;
          if (m[1] !== DEV_FEATURES[i].val) allOk = false;
        }
        if (!touched) return null;
        // Sisa query (fitur non-sensitif) harus tetap dievaluasi asli.
        for (let i = 0; i < DEV_FEATURES.length; i++) rest = rest.replace(DEV_FEATURES[i].re, '');
        rest = rest.replace(/\band\b|\ball\b|\bor\b|[\s()]/g, '');
        const pureSensitive = rest === '';
        return { ok: allOk, pure: pureSensitive };
      } catch (e) { return null; }
    }
    let target = null;
    const o = Object.getOwnPropertyDescriptor(win, 'matchMedia');
    if (o && typeof o.value === 'function') target = win;
    else if (win.Window && win.Window.prototype) {
      const op = Object.getOwnPropertyDescriptor(win.Window.prototype, 'matchMedia');
      if (op && typeof op.value === 'function') target = win.Window.prototype;
    }
    if (!target) return;
    kit.patchMethod(target, 'matchMedia', function (orig) {
      return function matchMedia(q) {
        const mql = orig.apply(this, arguments);
        try {
          const v = verdict(String(q));
          if (!v) return mql;
          const matches = v.pure ? v.ok : (v.ok && mql.matches);
          return new win.Proxy(mql, {
            get: function (t, k) {
              if (k === 'matches') return matches;
              const val = t[k];
              return typeof val === 'function' ? val.bind(t) : val;
            }
          });
        } catch (e) { return mql; }
      };
    });
  } catch (e) { /* diam */ }

  /* mediaCapabilities.decodingInfo. */
  try {
    if (!ctx.cfg.surfaces.media) return;
    const MC = win.MediaCapabilities && win.MediaCapabilities.prototype;
    if (!MC || typeof MC.decodingInfo !== 'function') return;
    const powerEfficient = ctx.locked('mediaPowerEff', function () {
      return makeRng('kabut/mediacap|' + ctx.seed + '|' + ctx.domain)() < 0.72;
    });
    kit.patchMethod(MC, 'decodingInfo', function (orig) {
      return function decodingInfo(config) {
        try {
          /* v3-FIX: argumen tidak valid → fungsi asli (TypeError asli). */
          if (!config || typeof config !== 'object' || typeof config.type !== 'string') {
            return orig.apply(this, arguments);
          }
          return win.Promise.resolve({
            supported: true,
            smooth: true,
            powerEfficient: powerEfficient,
            configuration: config
          });
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
  } catch (e) { /* diam */ }
}

function applyVoices(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.voices) return;
    const SSP = win.SpeechSynthesis && win.SpeechSynthesis.prototype;
    if (!SSP || typeof SSP.getVoices !== 'function') return;
    kit.patchMethod(SSP, 'getVoices', function (orig) {
      return function getVoices() {
        const v = orig.apply(this, arguments);
        try {
          if (!Array.isArray(v) || v.length < 2) return v;
          const perm = makePermutation(ctx.seed + '|voices|' + ctx.domain, v.length);
          const out = v.slice();
          for (let i = 0; i < v.length; i++) out[perm[i]] = v[i];
          return out;
        } catch (e) { return v; }
      };
    });
  } catch (e) { /* diam */ }
}


/* =====================================================================
 * BAGIAN 15 — MEDIADEVICES (enumerateDevices + terjemahan deviceId
 *             dua arah — fungsional penuh, konsistensi silang)
 * ===================================================================== */

function makeDeviceIdTranslator(ctx) {
  /* Peta real→spoof deterministik + peta balik spoof→real. */
  const fwd = new Map();
  const rev = new Map();

  function spoofIdFor(realId, saltIdx) {
    const key = String(realId || ('idx' + saltIdx));
    let sp = fwd.get(key);
    if (!sp) {
      const rng = makeRng('kabut/dev|' + ctx.seed + '|' + ctx.domain + '|' + key);
      sp = 'k' + hex8(rngInt(rng)) + hex8(rngInt(rng));
      fwd.set(key, sp);
      rev.set(sp, key);
    }
    return sp;
  }

  function realIdFor(spoofedId) {
    const s = String(spoofedId || '');
    if (!s) return s;
    if (rev.has(s)) return rev.get(s);
    return s; // id asli milik situs → lewat apa adanya
  }

  return { spoofIdFor: spoofIdFor, realIdFor: realIdFor };
}

function applyDevices(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.devices) return;
    const MD = win.MediaDevices && win.MediaDevices.prototype;
    if (!MD || typeof MD.enumerateDevices !== 'function') return;

    const tr = ctx.locked('devTranslator', function () {
      return makeDeviceIdTranslator(ctx);
    });

    kit.patchMethod(MD, 'enumerateDevices', function (orig) {
      return function enumerateDevices() {
        return orig.apply(this, arguments).then(function (devices) {
          try {
            return devices.map(function (d, i) {
              /* v3: deviceId/groupId KOSONG sebelum izin → tetap kosong
               * (konsisten native Chrome; id terisi hanya setelah izin,
               * lalu di-hash dua arah). */
              const devId = (d && d.deviceId) ? tr.spoofIdFor(d.deviceId, i) : '';
              const grpId = (d && d.groupId) ? tr.spoofIdFor(d.groupId + '|g', i) : '';
              const kind = d && d.kind;
              const shim = makeShim(win, win.MediaDeviceInfo, {
                deviceId: { get: function () { return devId; } },
                groupId: { get: function () { return grpId; } },
                kind: { get: function () { return kind; } },
                label: { get: function () { return ''; } },
                toJSON: {
                  method: function () {
                    return { deviceId: devId, groupId: grpId, kind: kind, label: '' };
                  }, name: 'toJSON', len: 0
                }
              });
              return shim;
            });
          } catch (e) { return devices; }
        });
      };
    });

    /* Terjemahan deviceId pada getUserMedia (exact/ideal, string/array). */
    if (typeof MD.getUserMedia === 'function') {
      const translateConstraints = function (c) {
        try {
          if (!c || typeof c !== 'object') return c;
          const out = Object.assign({}, c);
          ['video', 'audio'].forEach(function (k) {
            const m = out[k];
            if (m && typeof m === 'object' && !Array.isArray(m)) {
              const dv = m.deviceId;
              if (typeof dv === 'string') {
                out[k] = Object.assign({}, m, { deviceId: tr.realIdFor(dv) });
              } else if (dv && typeof dv === 'object') {
                const nd = {};
                if (dv.exact !== undefined) nd.exact = typeof dv.exact === 'string' ? tr.realIdFor(dv.exact) : dv.exact;
                if (dv.ideal !== undefined) nd.ideal = typeof dv.ideal === 'string' ? tr.realIdFor(dv.ideal) : dv.ideal;
                out[k] = Object.assign({}, m, { deviceId: nd });
              }
            }
          });
          return out;
        } catch (e) { return c; }
      };
      kit.patchMethod(MD, 'getUserMedia', function (orig) {
        return function getUserMedia(constraints) {
          return orig.call(this, translateConstraints(constraints));
        };
      });
    }

    /* MediaStreamTrack — label generik + getSettings ter-spoof. */
    const MST = win.MediaStreamTrack && win.MediaStreamTrack.prototype;
    if (MST) {
      if (Object.getOwnPropertyDescriptor(MST, 'label')) {
        kit.patchAccessor(MST, 'label', function () {
          try {
            return this && this.kind === 'video' ? 'Default Video' : 'Default Audio';
          } catch (e) { return 'Default'; }
        });
      }
      if (typeof MST.getSettings === 'function') {
        kit.patchMethod(MST, 'getSettings', function (orig) {
          return function getSettings() {
            const s = orig.apply(this, arguments);
            try {
              if (s && typeof s === 'object') {
                if (typeof s.deviceId === 'string' && s.deviceId) {
                  s.deviceId = tr.spoofIdFor(s.deviceId, 0);
                }
                if (typeof s.groupId === 'string' && s.groupId) {
                  s.groupId = tr.spoofIdFor(s.groupId + '|g', 0);
                }
              }
            } catch (e) {}
            return s;
          };
        });
      }
      if (typeof MST.applyConstraints === 'function') {
        kit.patchMethod(MST, 'applyConstraints', function (orig) {
          return function applyConstraints(c) {
            try {
              if (c && typeof c === 'object' && typeof c.deviceId !== 'undefined') {
                const dv = c.deviceId;
                let nv = dv;
                if (typeof dv === 'string') nv = tr.realIdFor(dv);
                else if (dv && typeof dv === 'object') {
                  nv = {};
                  if (dv.exact !== undefined) nv.exact = typeof dv.exact === 'string' ? tr.realIdFor(dv.exact) : dv.exact;
                  if (dv.ideal !== undefined) nv.ideal = typeof dv.ideal === 'string' ? tr.realIdFor(dv.ideal) : dv.ideal;
                }
                const c2 = Object.assign({}, c, { deviceId: nv });
                return orig.call(this, c2);
              }
            } catch (e) { /* jatuh ke asli */ }
            return orig.apply(this, arguments);
          };
        });
      }
    }
  } catch (e) { /* diam */ }
}

/* =====================================================================
 * BAGIAN 16 — BATTERY, NETWORK INFO, STORAGE
 * ===================================================================== */

function applyBattery(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.battery) return;
    const NP = win.Navigator && win.Navigator.prototype;
    if (!NP || typeof NP.getBattery !== 'function') return;
    const b = ctx.spoof().battery;

    const wm = new WeakMap();
    const fake = makeShim(win, win.BatteryManager, {
      level: { get: function () { return b.level; } },
      charging: { get: function () { return b.charging; } },
      chargingTime: { get: function () { return b.charging ? b.chargingTime : Infinity; } },
      dischargingTime: { get: function () { return b.charging ? Infinity : b.dischargingTime; } },
      onlevelchange: {
        get: function (t) { return wm.get(t) || null; },
        set: function (t, v) { wm.set(t, typeof v === 'function' ? v : null); return true; }
      }
    });

    kit.patchMethod(NP, 'getBattery', function (orig) {
      return function getBattery() {
        try { return win.Promise.resolve(fake); } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
  } catch (e) { /* diam */ }
}

function applyNetwork(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.network) return;
    const NP = win.Navigator && win.Navigator.prototype;
    if (!NP) return;
    const c = ctx.spoof().conn;

    const wm = new WeakMap();
    const fake = makeShim(win, win.NetworkInformation, {
      effectiveType: { get: function () { return c.effectiveType; } },
      type: { get: function () { return c.type; } },
      downlink: { get: function () { return c.downlink; } },
      rtt: { get: function () { return c.rtt; } },
      saveData: { get: function () { return c.saveData; } },
      onchange: {
        get: function (t) { return wm.get(t) || null; },
        set: function (t, v) { wm.set(t, typeof v === 'function' ? v : null); return true; }
      }
    });

    kit.patchAccessor(NP, 'connection', function () {
      return ctx.locked('connObj', function () { return fake; });
    });
    /* Alias lama webkitConnection bila ada. */
    try {
      if (Object.getOwnPropertyDescriptor(NP, 'webkitConnection')) {
        kit.patchAccessor(NP, 'webkitConnection', function () {
          return ctx.locked('connObj', function () { return fake; });
        });
      }
    } catch (e) {}
  } catch (e) { /* diam */ }
}

function applyStorage(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.storage) return;
    const SM = win.StorageManager && win.StorageManager.prototype;
    if (!SM || typeof SM.estimate !== 'function') return;
    kit.patchMethod(SM, 'estimate', function (orig) {
      return function estimate() {
        try {
          const sp = ctx.spoof();
          return win.Promise.resolve({ usage: sp.usage, quota: sp.quota });
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
  } catch (e) { /* diam */ }
}

/* =====================================================================
 * BAGIAN 17 — v3-BARU: API PERANGKAT EKSTERNAL (hwapi)
 * Bluetooth / USB / HID / Serial / XR / Gamepad / RelatedApps /
 * permission sensor gerak — seluruhnya enumerasi atau probe perangkat
 * → dilaporkan "tidak ada perangkat / tidak didukung" (nilai lazy yang
 * identik dengan desktop tanpa perangkat terpasang). Situs degradasi
 * dengan anggun; tidak ada error sintaksis, hanya data kosong.
 * ===================================================================== */

function applyHwApi(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.hwapi) return;
    const NP = win.Navigator && win.Navigator.prototype;

    /* --- Web Bluetooth --- */
    try {
      const B = win.Bluetooth;
      if (B && B.prototype) {
        if (typeof B.prototype.getAvailability === 'function') {
          kit.patchMethod(B.prototype, 'getAvailability', function (orig) {
            return function getAvailability() {
              return win.Promise.resolve(false);
            };
          });
        }
        if (typeof B.prototype.getDevices === 'function') {
          kit.patchMethod(B.prototype, 'getDevices', function (orig) {
            return function getDevices() {
              return win.Promise.resolve([]);
            };
          });
        }
        if (typeof B.prototype.requestDevice === 'function') {
          kit.patchMethod(B.prototype, 'requestDevice', function (orig) {
            return function requestDevice() {
              return win.Promise.reject(new win.DOMException('User cancelled the request.', 'NotFoundError'));
            };
          });
        }
      }
    } catch (e) { /* diam */ }

    /* --- Web USB --- */
    try {
      const USB = win.USB;
      if (USB && USB.prototype) {
        if (typeof USB.prototype.getDevices === 'function') {
          kit.patchMethod(USB.prototype, 'getDevices', function (orig) {
            return function getDevices() {
              return win.Promise.resolve([]);
            };
          });
        }
        if (typeof USB.prototype.requestDevice === 'function') {
          kit.patchMethod(USB.prototype, 'requestDevice', function (orig) {
            return function requestDevice() {
              return win.Promise.reject(new win.DOMException('No device selected.', 'NotFoundError'));
            };
          });
        }
      }
    } catch (e) { /* diam */ }

    /* --- Web HID --- */
    try {
      const HID = win.HID;
      if (HID && HID.prototype) {
        if (typeof HID.prototype.getDevices === 'function') {
          kit.patchMethod(HID.prototype, 'getDevices', function (orig) {
            return function getDevices() {
              return win.Promise.resolve([]);
            };
          });
        }
        if (typeof HID.prototype.requestDevice === 'function') {
          kit.patchMethod(HID.prototype, 'requestDevice', function (orig) {
            return function requestDevice() {
              return win.Promise.reject(new win.DOMException('No device selected.', 'NotFoundError'));
            };
          });
        }
      }
    } catch (e) { /* diam */ }

    /* --- Web Serial --- */
    try {
      const Serial = win.Serial;
      if (Serial && Serial.prototype) {
        if (typeof Serial.prototype.getPorts === 'function') {
          kit.patchMethod(Serial.prototype, 'getPorts', function (orig) {
            return function getPorts() {
              return win.Promise.resolve([]);
            };
          });
        }
        if (typeof Serial.prototype.requestPort === 'function') {
          kit.patchMethod(Serial.prototype, 'requestPort', function (orig) {
            return function requestPort() {
              return win.Promise.reject(new win.DOMException('No port selected.', 'NotFoundError'));
            };
          });
        }
      }
    } catch (e) { /* diam */ }

    /* --- WebXR --- */
    try {
      const XR = win.XRSystem && win.XRSystem.prototype;
      if (XR) {
        if (typeof XR.isSessionSupported === 'function') {
          kit.patchMethod(XR, 'isSessionSupported', function (orig) {
            return function isSessionSupported() {
              return win.Promise.resolve({ supported: false });
            };
          });
        }
        if (typeof XR.requestSession === 'function') {
          kit.patchMethod(XR, 'requestSession', function (orig) {
            return function requestSession() {
              return win.Promise.reject(new win.DOMException('XR is not available.', 'NotSupportedError'));
            };
          });
        }
      }
    } catch (e) { /* diam */ }

    /* --- Gamepad (mengembalikan bentuk native "tanpa gamepad"). --- */
    if (NP && typeof NP.getGamepads === 'function') {
      kit.patchMethod(NP, 'getGamepads', function (orig) {
        return function getGamepads() {
          try { return [null, null, null, null]; }
          catch (e) { return orig.apply(this, arguments); }
        };
      });
    }

    /* --- Get Installed Related Apps (vektor fingerprinting — Mozilla). --- */
    if (NP && typeof NP.getInstalledRelatedApps === 'function') {
      kit.patchMethod(NP, 'getInstalledRelatedApps', function (orig) {
        return function getInstalledRelatedApps() {
          return win.Promise.resolve([]);
        };
      });
    }

    /* --- Permission sensor gerak (DeviceMotion/Orientation) → denied. --- */
    const evts = ['DeviceMotionEvent', 'DeviceOrientationEvent'];
    for (let i = 0; i < evts.length; i++) {
      try {
        const E = win[evts[i]];
        if (E && typeof E.requestPermission === 'function') {
          kit.patchMethod(E, 'requestPermission', function (orig) {
            return function requestPermission() {
              return win.Promise.resolve('denied');
            };
          });
        }
      } catch (e) { /* diam */ }
    }
  } catch (e) { /* diam */ }
}


/* =====================================================================
 * BAGIAN 18 — WEBRTC (lapisan JS; lapisan jaringan via chrome.privacy
 * ditangani Service Worker). Empat mode:
 *  - strict  : hanya kandidat mDNS (.local) yang lolos (srflx/prflx/host-IP/relay dibuang)
 *  - balanced: mDNS + relay (TURN) lolos; IP publik & lokal tetap dibuang
 *  - block   : RTCPeerConnection melempar error (semua situs WebRTC rusak)
 *  - off     : tanpa wrapper
 *
 * Keamanan jalur "vanilla ICE": SDP disanitasi pada SEMUA jalur keluar:
 *  - createOffer / createAnswer / setLocalDescription (nilai resolve)
 *  - getter instance localDescription / currentLocalDescription /
 *    pendingLocalDescription (dibungkus RTCSessionDescription asli)
 * Termasuk sanitasi getStats (laporan ICE menyimpan alamat IP lokal)
 * — laporan dibangun sebagai Proxy bersih di atas rantai
 * RTCStatsReport.prototype (instanceof ✓, own-keys bersih ✓).
 * ===================================================================== */

function parseCandidate(str) {
  const m = /candidate:(\S+)\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+typ\s+(\S+)/.exec(String(str));
  if (!m) return null;
  return { addr: m[2], typ: m[3] };
}

function dropCandidateStr(str, allowRelay) {
  if (!str) return false;
  const c = parseCandidate(str);
  if (!c) return false;
  if (c.typ === 'srflx' || c.typ === 'prflx') return true;   // IP publik
  if (c.typ === 'host') return !/\.local$/i.test(c.addr);    // IP privat
  if (c.typ === 'relay') return !allowRelay;                 // TURN relay
  return false;
}

/** Sanitasi teks SDP: buang baris a=candidate yang melanggar kebijakan. */
function sanitizeSdpText(sdp, allowRelay) {
  try {
    if (typeof sdp !== 'string' || sdp.indexOf('a=candidate') < 0) return sdp;
    const nl = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const lines = sdp.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf('a=candidate:') === 0 && dropCandidateStr(line, allowRelay)) continue;
      out.push(line);
    }
    return out.join(nl);
  } catch (e) { return sdp; }
}

/** Bungkus ulang RTCSessionDescription dengan SDP tersanitasi. */
function sanitizeSessionDesc(win, desc, allowRelay) {
  try {
    if (!desc || typeof desc !== 'object') return desc;
    const cleanSdp = sanitizeSdpText(desc.sdp, allowRelay);
    if (cleanSdp === desc.sdp) return desc;
    try {
      return new win.RTCSessionDescription({ type: desc.type, sdp: cleanSdp });
    } catch (e) { return desc; }
  } catch (e) { return desc; }
}

function applyWebRTC(win, ctx, kit) {
  try {
    const mode = ctx.cfg.webrtc;
    if (mode === 'off') return;
    const NativePC = win.RTCPeerConnection;
    if (!NativePC) return;

    if (mode === 'block') {
      const Blocked = function RTCPeerConnection() {
        throw new win.TypeError("Failed to construct 'RTCPeerConnection': WebRTC is disabled.");
      };
      kit.nativize(Blocked, 'RTCPeerConnection', 0);
      kit.patchWindowValue(win, 'RTCPeerConnection', Blocked);
      return;
    }

    const allowRelay = mode === 'balanced';

    function guardPeer(pc) {
      const evtMap = new Map();
      const descOnICE = Object.getOwnPropertyDescriptor(NativePC.prototype, 'onicecandidate');
      let userICE = null;

      function wrapICEHandler(fn) {
        return function (ev) {
          try {
            if (ev && ev.candidate && dropCandidateStr(ev.candidate.candidate, allowRelay)) return;
          } catch (e) {}
          return fn.call(pc, ev);
        };
      }

      if (descOnICE && descOnICE.set) {
        Object.defineProperty(pc, 'onicecandidate', {
          get: function () { return userICE; },
          set: function (fn) {
            userICE = typeof fn === 'function' ? fn : null;
            descOnICE.set.call(pc, userICE ? wrapICEHandler(userICE) : null);
          },
          enumerable: true,
          configurable: true
        });
      }

      const NativeAdd = NativePC.prototype.addEventListener;
      const NativeRemove = NativePC.prototype.removeEventListener;

      const addFn = function addEventListener(type, fn, opts) {
        if (type === 'icecandidate' && typeof fn === 'function') {
          const wrapped = wrapICEHandler(fn);
          evtMap.set(fn, wrapped);
          return NativeAdd.call(pc, type, wrapped, opts);
        }
        return NativeAdd.call(pc, type, fn, opts);
      };
      kit.nativize(addFn, 'addEventListener', 2);
      Object.defineProperty(pc, 'addEventListener', { value: addFn, writable: true, enumerable: false, configurable: true });

      const remFn = function removeEventListener(type, fn, opts) {
        if (type === 'icecandidate' && evtMap.has(fn)) {
          const wrapped = evtMap.get(fn);
          evtMap.delete(fn);
          return NativeRemove.call(pc, type, wrapped, opts);
        }
        return NativeRemove.call(pc, type, fn, opts);
      };
      kit.nativize(remFn, 'removeEventListener', 2);
      Object.defineProperty(pc, 'removeEventListener', { value: remFn, writable: true, enumerable: false, configurable: true });

      /* Sanitasi SDP pada jalur deskripsi lokal (fix bypass vanilla ICE). */
      const descProps = ['localDescription', 'currentLocalDescription', 'pendingLocalDescription'];
      for (let i = 0; i < descProps.length; i++) {
        const prop = descProps[i];
        try {
          const d = Object.getOwnPropertyDescriptor(NativePC.prototype, prop);
          if (d && d.get) {
            const origGet = d.get;
            const getter = function () {
              return sanitizeSessionDesc(win, origGet.call(pc), allowRelay);
            };
            kit.nativize(getter, prop, 0);
            Object.defineProperty(pc, prop, {
              get: getter,
              set: typeof d.set === 'function' ? d.set : undefined,
              enumerable: true,
              configurable: true
            });
          }
        } catch (e) { /* diam */ }
      }

      /* Hasil createOffer/createAnswer/setLocalDescription disanitasi. */
      const offerFns = ['createOffer', 'createAnswer', 'setLocalDescription'];
      for (let i = 0; i < offerFns.length; i++) {
        const fname = offerFns[i];
        try {
          const origFn = NativePC.prototype[fname];
          if (typeof origFn !== 'function') continue;
          const wrapped = function () {
            const r = origFn.apply(pc, arguments);
            if (r && typeof r.then === 'function') {
              return r.then(function (desc) {
                return (desc && desc.sdp) ? sanitizeSessionDesc(win, desc, allowRelay) : desc;
              });
            }
            return r;
          };
          kit.nativize(wrapped, (origFn && origFn.name) || fname, (origFn && origFn.length) || 0);
          Object.defineProperty(pc, fname, { value: wrapped, writable: true, enumerable: false, configurable: true });
        } catch (e) { /* diam */ }
      }

      const NativeGetStats = NativePC.prototype.getStats;
      if (typeof NativeGetStats === 'function') {
        const gsFn = function getStats(selector) {
          return NativeGetStats.call(pc, selector).then(function (report) {
            return sanitizeStatsReport(win, report);
          });
        };
        kit.nativize(gsFn, 'getStats', 1);
        Object.defineProperty(pc, 'getStats', { value: gsFn, writable: true, enumerable: false, configurable: true });
      }
    }

    const KabutPC = function RTCPeerConnection(cfg, constraints) {
      if (!new.target) {
        throw new win.TypeError("Failed to construct 'RTCPeerConnection': Please use the 'new' operator.");
      }
      const pc = new NativePC(cfg, constraints);
      try { guardPeer(pc); } catch (e) { /* diam */ }
      return pc;
    };
    try { KabutPC.prototype = NativePC.prototype; } catch (e) {}
    try {
      if (NativePC.generateCertificate) KabutPC.generateCertificate = NativePC.generateCertificate;
    } catch (e) {}
    kit.nativize(KabutPC, 'RTCPeerConnection', NativePC.length || 0);

    kit.patchWindowValue(win, 'RTCPeerConnection', KabutPC);
  } catch (e) { /* diam */ }
}

/* Bersihkan field IP dari laporan statistik ICE (local-candidate). */
function sanitizeStatsReport(win, report) {
  try {
    const clean = [];
    if (report && typeof report.forEach === 'function') {
      report.forEach(function (stat, id) {
        try {
          if (stat && typeof stat === 'object' && stat.type === 'local-candidate') {
            const o = {};
            for (const k of Object.keys(stat)) {
              if (k === 'address' || k === 'ip' || k === 'networkType' || k === 'url') continue;
              o[k] = stat[k];
            }
            clean.push([String(id), o]);
          } else {
            clean.push([String(id), stat]);
          }
        } catch (e) {
          clean.push([String(id), stat]);
        }
      });
    } else {
      return report;
    }

    const proto = (win.RTCStatsReport && win.RTCStatsReport.prototype) || Object.prototype;
    const target = Object.create(proto);
    const methods = Object.create(null);

    function reg(name, len, fn) {
      const f = function () { return fn.apply(null, arguments); };
      nativizeShared(f, name, len);
      methods[name] = f;
    }

    const find = function (k) {
      for (let i = 0; i < clean.length; i++) if (clean[i][0] === String(k)) return clean[i][1];
      return undefined;
    };
    reg('get', 1, find);
    reg('has', 1, function (k) { return find(k) !== undefined; });
    reg('keys', 0, function () { return clean.map(function (e) { return e[0]; }); });
    reg('values', 0, function () { return clean.map(function (e) { return e[1]; }); });
    reg('entries', 0, function () { return clean.map(function (e) { return [e[0], e[1]]; }); });
    reg('forEach', 1, function (cb, thisArg) {
      for (let i = 0; i < clean.length; i++) {
        try { cb.call(thisArg || null, clean[i][1], clean[i][0], proxyRef); } catch (e) {}
      }
    });
    if (typeof win.Symbol === 'function' && win.Symbol.iterator) {
      const itFn = function () {
        const arr = clean.map(function (e) { return [e[0], e[1]]; });
        const idx = { i: 0 };
        return {
          next: function () {
            if (idx.i < arr.length) { const v = arr[idx.i]; idx.i++; return { value: v, done: false }; }
            return { value: undefined, done: true };
          }
        };
      };
      nativizeShared(itFn, win.Symbol.iterator.toString() || 'Symbol.iterator', 0);
      methods[win.Symbol.iterator] = itFn;
    }

    let proxyRef = null;
    const handler = {
      get: function (t, k) {
        try {
          if (k === 'size') return clean.length;
          if (Object.prototype.hasOwnProperty.call(methods, k)) return methods[k];
          if (typeof k === 'string') {
            const v = find(k);
            if (v !== undefined) return v;
          }
          return t[k];
        } catch (e) { return undefined; }
      },
      has: function (t, k) {
        try {
          if (Object.prototype.hasOwnProperty.call(methods, k)) return true;
          if (typeof k === 'string' && find(k) !== undefined) return true;
          return k in t;
        } catch (e) { return false; }
      }
    };
    proxyRef = new win.Proxy(target, handler);
    return proxyRef;
  } catch (e) { return report; }
}


/* =====================================================================
 * BAGIAN 19 — v3-BARU: WEBGPU
 * navigator.gpu.requestAdapter() → GPUAdapter:
 *  - adapter.info (GPUAdapterInfo: vendor/architecture/device/description)
 *  - adapter.limits (GPUSupportedLimits — batas numerik bervariasi per GPU)
 *  - adapter.features (GPUSupportedFeatures — bervariasi per GPU/driver)
 *  - adapter.requestDevice() → GPUDevice (features/limits juga)
 *
 * Strategi spoof (selaras riset Brave 1.93 + browserleaks.com/webgpu):
 *  1. GPUAdapterInfo → vendor pool generik + fallback standar Chromium
 *     ('common-3d', '', '') — nilai yang dilaporkan mayoritas instalasi.
 *  2. limits → nilai MINIMUM spesifikasi untuk kunci entropy tinggi
 *     (dijamin tidak pernah melebihi kemampuan adapter nyata → nol
 *     breakage; seragam antar-pengguna → nol entropy).
 *  3. features → difilter ke daftar fitur lazim desktop (hanya
 *     MENGHAPUS, tidak pernah menambah → situs tidak akan meminta
 *     fitur yang tak didukung nyata → nol breakage).
 *  4. Semua objek dibungkus makeBoundProxy di atas INSTANSI NYATA:
 *     method native (createBuffer, requestDevice, …) ter-bound ke
 *     instansi asli → panggilan valid, toString native, identitas stabil.
 * ===================================================================== */

function applyWebGPU(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.webgpu) return;
    const GPUProto = win.GPU && win.GPU.prototype;
    if (!GPUProto || typeof GPUProto.requestAdapter !== 'function') return;

    const sp = ctx.spoof(); // mengunci wgpu + pools sekali per dokumen

    /* --- GPUAdapterInfo shim (data-only → makeShim cukup). --- */
    const infoShim = makeShim(win, win.GPUAdapterInfo, {
      vendor: { get: function () { return sp.wgpu.vendor; } },
      architecture: { get: function () { return sp.wgpu.architecture; } },
      device: { get: function () { return sp.wgpu.device; } },
      description: { get: function () { return sp.wgpu.description; } }
    });

    /* --- Tampilan fitur terfilter (set-like, hanya menghapus). --- */
    function makeFeaturesView(realFeatures) {
      const filtered = [];
      try {
        realFeatures.forEach(function (f) {
          if (WGPU_COMMON_FEATURES.indexOf(f) >= 0) filtered.push(f);
        });
      } catch (e) {}
      const fset = new win.Set(filtered);
      const overrides = {
        size: { get: function () { return fset.size; } },
        has: { method: function has(v) { return fset.has(v); }, name: 'has', len: 1 },
        forEach: { method: function forEach(cb, ta) { return fset.forEach(cb, ta); }, name: 'forEach', len: 1 },
        entries: { method: function entries() { return fset.entries(); }, name: 'entries', len: 0 },
        keys: { method: function keys() { return fset.keys(); }, name: 'keys', len: 0 },
        values: { method: function values() { return fset.values(); }, name: 'values', len: 0 }
      };
      if (typeof win.Symbol === 'function' && win.Symbol.iterator) {
        overrides[win.Symbol.iterator] = {
          method: function () { return fset.values(); }
        };
      }
      return makeBoundProxy(win, realFeatures, overrides);
    }

    /* --- Tampilan limits (kunci entropy tinggi → minimum spesifikasi). --- */
    function makeLimitsView(realLimits) {
      const overrides = {};
      for (const k of Object.keys(WGPU_LIMITS_SPOOF)) {
        overrides[k] = WGPU_LIMITS_SPOOF[k]; // nilai statis
      }
      return makeBoundProxy(win, realLimits, overrides);
    }

    /* --- Pembungkus adapter. --- */
    function wrapAdapter(realAdapter) {
      const featuresView = makeFeaturesView(realAdapter.features);
      const limitsView = makeLimitsView(realAdapter.limits);

      const adapterShim = makeBoundProxy(win, realAdapter, {
        info: { get: function () { return infoShim; } },
        features: { get: function () { return featuresView; } },
        limits: { get: function () { return limitsView; } },
        requestAdapterInfo: {
          method: function requestAdapterInfo() {
            return win.Promise.resolve(infoShim);
          }, name: 'requestAdapterInfo', len: 0
        },
        requestDevice: {
          method: function requestDevice(desc) {
            const p = realAdapter.requestDevice(desc);
            return win.Promise.resolve(p).then(function (dev) {
              return dev ? wrapDevice(dev) : dev;
            });
          }, name: 'requestDevice', len: 1
        }
      });
      return adapterShim;
    }

    /* --- Pembungkus device (features/limits konsisten dengan adapter). --- */
    function wrapDevice(realDevice) {
      const featuresView = makeFeaturesView(realDevice.features);
      const limitsView = makeLimitsView(realDevice.limits);
      return makeBoundProxy(win, realDevice, {
        features: { get: function () { return featuresView; } },
        limits: { get: function () { return limitsView; } }
      });
    }

    kit.patchMethod(GPUProto, 'requestAdapter', function (orig) {
      return function requestAdapter() {
        const r = orig.apply(this, arguments);
        if (r && typeof r.then === 'function') {
          return r.then(function (adapter) {
            return adapter ? wrapAdapter(adapter) : adapter;
          });
        }
        return r;
      };
    });
  } catch (e) { /* diam */ }
}


/* =====================================================================
 * BAGIAN 20 — v3-BARU: FARBLING WEB WORKER (blob)
 * Keterbatasan terbesar v2: nilai di dalam lingkup Worker TIDAK dapat
 * dipatch content script (setiap realm worker punya navigator &
 * OffscreenCanvas sendiri). Fingerprinter cukup membuat blob-worker
 * lalu membaca navigator.hardwareConcurrency / merender OffscreenCanvas
 * DI DALAM worker → membaca nilai asli.
 *
 * Solusi v3: bungkus konstruktor Worker/SharedWorker + intersepsi
 * URL.createObjectURL. Saat halaman membuat Worker dari blob URL,
 * blob asli digabungkan dengan PRELUDE yang dipatch di dalam lingkup
 * worker itu sendiri:
 *   - WorkerNavigator.hardwareConcurrency / userAgent → nilai spoof
 *   - OffscreenCanvasRenderingContext2D.getImageData → noise
 *   - OffscreenCanvas.convertToBlob → noise
 *   - WebGL getParameter (UNMASKED vendor/renderer) & readPixels → spoof
 * Tabel noise memakai stream seed IDENTIK dengan thread utama
 * (kabut/canvas|SEED|canvas|DOMAIN) → hash kanvas worker == hash
 * kanvas utama (konsistensi lintas realm).
 *
 * Keamanan breakage:
 *  - Hanya blob worker yang dibungkus (worker ber-URL file asli tidak
 *    bisa diubah dengan aman → dibiarkan, didokumentasikan).
 *  - Jika pembuatan worker terbungkus gagal (CSP dsb.) → fallback ke
 *    worker asli dengan argumen ORISINAL (perilaku native dipertahankan).
 *  - Module worker: prelude adalah statement valid di awal module.
 *  - URL blob asli tetap valid untuk keperluan lain (fetch, img, dsb.);
 *    worker terbungkus memakai URL blob kedua yang dibuat internal.
 * ===================================================================== */

function buildWorkerPrelude(a) {
  a = a || {};
  const A = JSON.stringify({
    seed: String(a.seed || ''),
    domain: String(a.domain || ''),
    amp: Number(a.amp) || 2,
    mode: String(a.mode || 'noise'),
    cores: Number(a.cores) || 4,
    ua: String(a.ua || ''),
    gv: String(a.gpuVendor || ''),
    gr: String(a.gpuRenderer || ''),
    mt: Number(a.maxTexture) || 16384,
    mv: Array.isArray(a.maxViewport) ? [Number(a.maxViewport[0]) || 16384, Number(a.maxViewport[1]) || 16384] : [16384, 16384],
    gl: a.webglOn ? 1 : 0
  });
  return [
    '(function(){',
    '"use strict";',
    'var A=' + A + ';',
    'function _x(str){var h=1779033703^str.length;for(var i=0;i<str.length;i++){h=Math.imul(h^str.charCodeAt(i),3432918353);h=(h<<13)|(h>>>19);}return function(){h=Math.imul(h^(h>>>16),2246822507);h=Math.imul(h^(h>>>13),3266489909);h^=h>>>16;return h>>>0;};}',
    'function _s(a,b,c,d){return function(){a>>>=0;b>>>=0;c>>>=0;d>>>=0;var t=(a+b)|0;a=b^(b>>>9);b=c+((c<<3)|0)|0;c=(c<<21)|(c>>>11);d=(d+1)|0;t=(t+d)|0;c=(c+t)|0;return(t>>>0)/4294967296;};}',
    'function _r(s){var g=_x(String(s));return _s(g(),g(),g(),g());}',
    'function _h(n){n=(n^61)^(n>>>16);n=(n+(n<<3))|0;n=n^(n>>>4);n=Math.imul(n,0x27d4eb2d);n=n^(n>>>15);return n>>>0;}',
    'function _c(v){return v<0?0:(v>255?255:v);}',
    'var _NAT=new WeakMap();',
    'function _n(f,nm,l){try{_NAT.set(f,"function "+nm+"() { [native code] }");}catch(e){}try{Object.defineProperty(f,"name",{value:nm,configurable:true});}catch(e){}try{Object.defineProperty(f,"length",{value:l,configurable:true});}catch(e){}return f;}',
    'try{var _FT=Function.prototype,_D=Object.getOwnPropertyDescriptor(_FT,"toString");if(_D&&_D.value){var _O=_D.value;var _F=function toString(){var s=_NAT.get(this);return s!==undefined?s:_O.call(this);};_n(_F,"toString",0);Object.defineProperty(_FT,"toString",{value:_F,writable:true,enumerable:false,configurable:true});}}catch(e){}',
    'var _TAB=null;function _tab(){if(_TAB)return _TAB;var r=_r("kabut/canvas|"+A.seed+"|canvas|"+A.domain);_TAB=[];for(var i=0;i<512;i++){var v=Math.round((r()*2-1)*A.amp);if(v===0)v=r()<0.5?-1:1;if(v>A.amp)v=A.amp;if(v<-A.amp)v=-A.amp;_TAB.push(v);}return _TAB;}',
    'function _nAt(x,y,ch){return _TAB[_h((Math.imul(x|0,73856093))^(Math.imul(y|0,19349663))^(Math.imul(ch|0,83492791)))&511];}',
    'function _noise(d,w){for(var p=0;p<(d.length>>2);p++){var i=p<<2;if(d[i+3]===0)continue;var xx=p%w,yy=(p/w)|0;d[i]=_c(d[i]+_nAt(xx,yy,0));d[i+1]=_c(d[i+1]+_nAt(xx,yy,1));d[i+2]=_c(d[i+2]+_nAt(xx,yy,2));}}',
    'var _GT=null;function _glt(){if(_GT)return _GT;var r=_r("kabut/canvas|"+A.seed+"|glread|"+A.domain);_GT=[];for(var i=0;i<512;i++){var v=Math.round((r()*2-1)*1);if(v===0)v=r()<0.5?-1:1;_GT.push(v);}return _GT;}',
    'try{var WN=self.WorkerNavigator;if(WN&&WN.prototype){try{Object.defineProperty(WN.prototype,"hardwareConcurrency",{get:function(){return A.cores;},configurable:true,enumerable:true});}catch(e){}if(A.ua){try{Object.defineProperty(WN.prototype,"userAgent",{get:function(){return A.ua;},configurable:true,enumerable:true});}catch(e){}}}}catch(e){}',
    'try{var OC=self.OffscreenCanvas,OC2=self.OffscreenCanvasRenderingContext2D,_og=null;',
    'if(OC2&&OC2.prototype&&typeof OC2.prototype.getImageData==="function"){_og=OC2.prototype.getImageData;',
    'OC2.prototype.getImageData=function(){var img=_og.apply(this,arguments);try{if(A.mode==="noise"){_tab();_noise(img.data,(arguments[2]&&arguments[2]>0)?arguments[2]:(img.width||1));}else if(A.mode==="block"){var d=img.data;for(var i=0;i<d.length;i+=4){d[i]=0;d[i+1]=0;d[i+2]=0;d[i+3]=255;}}}catch(e){}return img;};_n(OC2.prototype.getImageData,"getImageData",4);}',
    'if(OC&&OC.prototype&&typeof OC.prototype.convertToBlob==="function"&&_og){var _oc=OC.prototype.convertToBlob;',
    'OC.prototype.convertToBlob=function(){try{if(A.mode!=="off"&&this&&this.width>0){var nc=new OC(this.width,this.height);var c2=nc.getContext("2d");if(c2){c2.drawImage(this,0,0);var img=_og.call(c2,0,0,nc.width,nc.height);if(A.mode==="block"){var d=img.data;for(var i=0;i<d.length;i+=4){d[i]=0;d[i+1]=0;d[i+2]=0;d[i+3]=255;}}else{_tab();_noise(img.data,nc.width||1);}c2.putImageData(img,0,0);return _oc.apply(nc,arguments);}}}catch(e){}return _oc.apply(this,arguments);};_n(OC.prototype.convertToBlob,"convertToBlob",0);}',
    '}catch(e){}',
    'if(A.gl){try{var _Ps=[self.WebGLRenderingContext,self.WebGL2RenderingContext];for(var pi=0;pi<_Ps.length;pi++){var P=_Ps[pi];if(!P||!P.prototype)continue;',
    'if(typeof P.prototype.getParameter==="function"){var og=P.prototype.getParameter;P.prototype.getParameter=function(p){try{if(p===37445)return A.gv;if(p===37446)return A.gr;if(p===3379||p===34024)return A.mt;if(p===3386)return new Int32Array([A.mv[0],A.mv[1]]);}catch(e){}return og.apply(this,arguments);};_n(P.prototype.getParameter,"getParameter",1);}',
    'if(typeof P.prototype.readPixels==="function"){var orp=P.prototype.readPixels;P.prototype.readPixels=function(x,y,w,h,f,t,px){var r=orp.apply(this,arguments);try{if(px&&px instanceof Uint8Array&&(f===6408||f===6407)){var st=f===6408?4:3;var ww=(w>0)?w:1;_glt();for(var i=0;i<px.length;i++){var ch=i%st;if(st===4&&ch===3)continue;if(st===4&&px[i-ch+3]===0)continue;var pix=(i/st)|0;px[i]=_c(px[i]+_nAt((x|0)+(pix%ww),(y|0)+((pix/ww)|0),ch));}}}catch(e){}return r;};_n(P.prototype.readPixels,"readPixels",7);}}}catch(e){}}',
    '})();'
  ].join('\n');
}

function applyWorkers(win, ctx, kit) {
  try {
    if (!ctx.cfg.surfaces.workers) return;
    const NativeWorker = win.Worker;
    if (!NativeWorker) return;

    const URLp = win.URL;
    const origCreate = URLp && typeof URLp.createObjectURL === 'function' ? URLp.createObjectURL : null;
    const origRevoke = URLp && typeof URLp.revokeObjectURL === 'function' ? URLp.revokeObjectURL : null;
    if (!origCreate) return;

    const urlBlob = new Map();

    /* Prelude dibangun sekali per dokumen (nilai spoof terkunci). */
    const preludeSrc = ctx.locked('workerPrelude', function () {
      const sp = ctx.spoof();
      const strength = CANVAS_AMP[ctx.cfg.surfaces.canvasStrength] !== undefined
        ? CANVAS_AMP[ctx.cfg.surfaces.canvasStrength] : 2;
      const cmode = ctx.cfg.surfaces.canvas;
      return buildWorkerPrelude({
        seed: ctx.seed,
        domain: ctx.domain,
        amp: strength,
        mode: (cmode === 'block' || cmode === 'off') ? cmode : 'noise',
        cores: sp.cores,
        ua: ctx.profile.isReal ? '' : ctx.profile.ua,
        gpuVendor: sp.gpu.vendor,
        gpuRenderer: sp.gpu.renderer,
        maxTexture: sp.maxTextureSize,
        maxViewport: sp.maxViewport,
        webglOn: !!ctx.cfg.surfaces.webgl
      });
    });

    const createWrapped = function createObjectURL(obj) {
      const u = origCreate.call(URLp, obj);
      try { if (obj instanceof win.Blob) urlBlob.set(String(u), obj); } catch (e) {}
      return u;
    };
    kit.nativize(createWrapped, 'createObjectURL', 1);
    try {
      Object.defineProperty(URLp, 'createObjectURL', {
        value: createWrapped, writable: true, enumerable: false, configurable: true
      });
    } catch (e) {}
    if (origRevoke) {
      const revokeWrapped = function revokeObjectURL(u) {
        try { urlBlob.delete(String(u)); } catch (e) {}
        return origRevoke.call(URLp, u);
      };
      kit.nativize(revokeWrapped, 'revokeObjectURL', 1);
      try {
        Object.defineProperty(URLp, 'revokeObjectURL', {
          value: revokeWrapped, writable: true, enumerable: false, configurable: true
        });
      } catch (e) {}
    }

    function wrappedWorkerUrl(url) {
      try {
        const blob = urlBlob.get(String(url));
        if (!blob) return null;
        const combined = new win.Blob([preludeSrc, blob], { type: 'text/javascript' });
        return origCreate.call(URLp, combined);
      } catch (e) { return null; }
    }

    const KabutWorker = function Worker(url, opts) {
      if (!new.target) {
        throw new win.TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
      }
      let wurl = null;
      try { wurl = wrappedWorkerUrl(url); } catch (e) { wurl = null; }
      if (wurl) {
        try { return new NativeWorker(wurl, opts); }
        catch (e) {
          /* CSP/kegagalan → fallback worker asli (perilaku native). */
          try { if (origRevoke) origRevoke.call(URLp, wurl); } catch (e2) {}
        }
      }
      return new NativeWorker(url, opts);
    };
    try { KabutWorker.prototype = NativeWorker.prototype; } catch (e) {}
    kit.nativize(KabutWorker, 'Worker', 1);
    kit.patchWindowValue(win, 'Worker', KabutWorker);

    const NativeShared = win.SharedWorker;
    if (NativeShared) {
      const KabutShared = function SharedWorker(url, opts) {
        if (!new.target) {
          throw new win.TypeError("Failed to construct 'SharedWorker': Please use the 'new' operator.");
        }
        let wurl = null;
        try { wurl = wrappedWorkerUrl(url); } catch (e) { wurl = null; }
        if (wurl) {
          try { return new NativeShared(wurl, opts); }
          catch (e) {
            try { if (origRevoke) origRevoke.call(URLp, wurl); } catch (e2) {}
          }
        }
        return new NativeShared(url, opts);
      };
      try { KabutShared.prototype = NativeShared.prototype; } catch (e) {}
      kit.nativize(KabutShared, 'SharedWorker', 1);
      kit.patchWindowValue(win, 'SharedWorker', KabutShared);
    }
  } catch (e) { /* diam */ }
}


/* =====================================================================
 * BAGIAN 21 — v3-BARU: GUARD window.open (fresh pristine window)
 * window.open() mengembalikan window baru yang SKRIP pembuka bisa
 * baca SEGERA — sebelum content script popup sempat menyuntik.
 * Guard ini mem-patch popup SINKRON saat open() kembali (popup
 * about:blank mewarisi origin pembuka → dapat dipatch lintas konteks).
 * Popup yang kemudian menavigasi ke URL http(s) akan di-inject content
 * script normal (document_start) — patch ini tidak mengganggu.
 * ===================================================================== */

function applyWindowOpenGuard(win, ctx, kit) {
  try {
    const d = Object.getOwnPropertyDescriptor(win, 'open');
    if (!d || typeof d.value !== 'function') return;
    const origOpen = d.value;
    const wrapped = function open() {
      const w = origOpen.apply(win, arguments);
      try { if (w) lazyPatchWindow(w, ctx); } catch (e) { /* diam */ }
      return w;
    };
    kit.nativize(wrapped, 'open', 1);
    kit.patchWindowValue(win, 'open', wrapped);
  } catch (e) { /* diam */ }
}

/* =====================================================================
 * BAGIAN 22 — ORKESTRASI: iframe guard, applyAll, ctx, bootstrap, ekspor
 * ===================================================================== */

const patchedWins = new WeakSet();

function applyAll(win, ctx, kit) {
  try {
    if (patchedWins.has(win)) return false;
    patchedWins.add(win);
    kit.installToStringGuard();
    applyNavigator(win, ctx, kit);
    applyScreen(win, ctx, kit);
    applyCanvas(win, ctx, kit);
    applyWebGL(win, ctx, kit);
    applyWebGPU(win, ctx, kit);
    applyAudio(win, ctx, kit);
    applyRects(win, ctx, kit);
    applyFonts(win, ctx, kit);
    applyMedia(win, ctx, kit);
    applyVoices(win, ctx, kit);
    applyDevices(win, ctx, kit);
    applyBattery(win, ctx, kit);
    applyNetwork(win, ctx, kit);
    applyStorage(win, ctx, kit);
    applyHwApi(win, ctx, kit);
    applyWebRTC(win, ctx, kit);
    applyWorkers(win, ctx, kit);
    applyWindowOpenGuard(win, ctx, kit);
    applyIframeGuard(win, ctx, kit);
    return true;
  } catch (e) { return false; }
}

/*
 * Anti-bypass "fresh window": fingerprinter mengambil fungsi pristin dari
 * iframe about:blank/srcdoc. Content script ter-inject via
 * match_origin_as_fallback, tetapi untuk kasus tepi kita juga mem-patch
 * window anak secara lazy saat contentWindow/contentDocument diakses.
 */
function applyIframeGuard(win, ctx, kit) {
  try {
    const IF = win.HTMLIFrameElement;
    if (!IF || !IF.prototype) return;

    const d = Object.getOwnPropertyDescriptor(IF.prototype, 'contentWindow');
    if (d && d.get) {
      const origGet = d.get;
      const wrappedGet = function contentWindow() {
        const w = origGet.call(this);
        try { lazyPatchWindow(w, ctx); } catch (e) { /* diam */ }
        return w;
      };
      kit.nativize(wrappedGet, 'contentWindow', 0);
      Object.defineProperty(IF.prototype, 'contentWindow', {
        get: wrappedGet,
        set: typeof d.set === 'function' ? d.set : undefined,
        enumerable: d.enumerable,
        configurable: true
      });
    }

    const dd = Object.getOwnPropertyDescriptor(IF.prototype, 'contentDocument');
    if (dd && dd.get) {
      const origGetD = dd.get;
      const wrappedGetD = function contentDocument() {
        const doc = origGetD.call(this);
        try { if (doc && doc.defaultView) lazyPatchWindow(doc.defaultView, ctx); } catch (e) {}
        return doc;
      };
      kit.nativize(wrappedGetD, 'contentDocument', 0);
      Object.defineProperty(IF.prototype, 'contentDocument', {
        get: wrappedGetD,
        set: typeof dd.set === 'function' ? dd.set : undefined,
        enumerable: dd.enumerable,
        configurable: true
      });
    }
  } catch (e) { /* diam */ }
}

function lazyPatchWindow(w, ctx) {
  try {
    if (!w || patchedWins.has(w)) return;
    const href = w.location && w.location.href; // cross-origin → throw → lewati
    if (typeof href !== 'string') return;
    const kit = makeStealthKit(w);
    applyAll(w, ctx, kit);
  } catch (e) { /* diam */ }
}

/* ---------- konteks per-dokumen ---------- */

function captureRealEnv(win) {
  const nav = win.navigator || {};
  let brands = null;
  try {
    if (nav.userAgentData && Array.isArray(nav.userAgentData.brands)) {
      brands = nav.userAgentData.brands;
    }
  } catch (e) {}
  return {
    ua: String(nav.userAgent || ''),
    brands: brands,
    platform: String(nav.platform || ''),
    cores: nav.hardwareConcurrency || 0,
    memory: nav.deviceMemory || 0,
    screenW: (win.screen && win.screen.width) || 800,
    screenH: (win.screen && win.screen.height) || 600,
    dpr: win.devicePixelRatio || 1,
    osFamily: osFamilyFromUA(nav.userAgent || '')
  };
}

function makeCtx(win, cfg, domain, seed) {
  const real = captureRealEnv(win);
  const ctx = {
    cfg: cfg,
    domain: String(domain || ''),
    seed: String(seed || ''),
    real: real,
    profile: null,
    locks: {},
    locked: function (name, fn) {
      if (!Object.prototype.hasOwnProperty.call(this.locks, name)) {
        try { this.locks[name] = fn(); } catch (e) { this.locks[name] = undefined; }
      }
      return this.locks[name];
    },
    hasLocks: function () {
      return Object.keys(this.locks).length > 0;
    },
    spoof: function () {
      const self = this;
      return this.locked('spoof', function () {
        return buildSpoofValues(self.real, self.profile, self.seed);
      });
    }
  };
  ctx.profile = buildProfile(real.ua, real.brands, cfg.profile);
  return ctx;
}

/* ---------- bootstrap di halaman web (world MAIN) ---------- */

const K_EVENT = 'kabut-cfg';
const K_ATTR = 'data-kabut-boot';

/** Dekripsi XOR: daftar kode → string. */
function xorDec(codesStr, padStr) {
  try {
    const pc = String(padStr).split(',');
    const parts = String(codesStr).split(',');
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      out += String.fromCharCode((parseInt(parts[i], 10) ^ pc[i % pc.length]) & 255);
    }
    return out;
  } catch (e) { return null; }
}

function bootInPage(win) {
  let booted = false;
  let ctxRef = null;
  let pad = null;
  let suppressBoot = false; // allowlist ter-cache → tanpa patch

  /* v3.1 — FASE SINKRON: bridge menurunkan {pad, dom, en, cfg} lewat
   * atribut DOM SEBELUM parser melanjutkan. Core membaca & MENGHAPUS
   * atributnya seketika (tak terlihat skrip halaman), lalu memasang
   * patch pada MILIDETIK PERTAMA — menutup race event-vs-parser MV3.
   * Pad = kunci enkripsi event asinkron (seed tak pernah polos). */
  try {
    const de = win.document.documentElement;
    const a = de.getAttribute(K_ATTR);
    if (a) {
      de.removeAttribute(K_ATTR);
      let info = null;
      try { info = JSON.parse(a); } catch (e) {}
      if (info && typeof info === 'object') {
        if (typeof info.pad === 'string' && info.pad.length > 8) pad = info.pad;
        if (info.en === false) suppressBoot = true;
        if (!suppressBoot) {
          const cfg = (info.cfg && typeof info.cfg === 'object') ? info.cfg : DEFAULT_CONFIG;
          const domain = String(info.dom || win.location.hostname || 'unknown');
          boot({
            enabled: true,
            cfg: cfg,
            domain: domain,
            seed: computeDomainSeed('kabut-ephemeral', domain)
          });
        }
      }
    }
  } catch (e) { /* diam */ }

  function boot(payload) {
    try {
      if (booted) {
        // Pembaruan live dari bridge (mis. toggle popup):
        if (ctxRef && payload) {
          ctxRef.cfg = normalizeSettings(payload.cfg || ctxRef.cfg);
          /* v3: seed hanya ditukar bila BELUM ada nilai ter-kunci —
           * menjamin konsistensi lintas realm (kanvas utama vs worker)
           * dan stabilitas intra-halaman saat seed baru tiba belakangan
           * (kasus: load pertama setelah install, secret tersimpan
           * beberapa ratus ms setelah halaman dibuka). */
          if (payload.seed && !ctxRef.hasLocks()) ctxRef.seed = String(payload.seed);
          ctxRef.profile = buildProfile(ctxRef.real.ua, ctxRef.real.brands, ctxRef.cfg.profile);
        }
        return;
      }
      booted = true;
      if (payload && payload.enabled === false) return; // situs allowlist → tanpa patch
      const cfg = normalizeSettings((payload && payload.cfg) || DEFAULT_CONFIG);
      const domain = String((payload && payload.domain) || win.location.hostname || 'unknown');
      let seed = payload && payload.seed ? String(payload.seed) : '';
      if (!seed) seed = computeDomainSeed('kabut-ephemeral', domain);
      const ctx = makeCtx(win, cfg, domain, seed);
      ctxRef = ctx;
      const kit = makeStealthKit(win);
      applyAll(win, ctx, kit);
    } catch (e) { /* diam */ }
  }

  function onCfg(ev) {
    try {
      const raw = ev && ev.detail;
      if (typeof raw !== 'string' || !raw) return;
      let payload = null;
      if (raw.charAt(0) === '{') {
        /* Bentuk polos tanpa-identitas (fallback bridge tanpa pad). */
        try { payload = JSON.parse(raw); } catch (e) { return; }
      } else if (pad) {
        /* Bentuk terenkripsi: hanya core yang memegang pad. */
        const dec = xorDec(raw, pad);
        if (!dec) return;
        try { payload = JSON.parse(dec); } catch (e) { return; }
      } else {
        return; // terenkripsi tanpa pad → abaikan (proteksi provisional tetap aktif)
      }
      if (!payload || typeof payload !== 'object') return;
      boot(payload);
    } catch (e) { /* diam */ }
  }

  try { win.document.addEventListener(K_EVENT, onCfg, true); } catch (e) {}

  // Fallback defensif: jika bridge lambat/gagal dan tidak ada atribut boot,
  // proteksi tetap menyala (seed fallback deterministik per-domain).
  win.setTimeout(function () {
    if (!booted && !suppressBoot) {
      boot({
        enabled: true,
        cfg: DEFAULT_CONFIG,
        domain: win.location.hostname || '',
        seed: computeDomainSeed('kabut-ephemeral', win.location.hostname || '')
      });
    }
  }, 60);
}

/* ---------- ekspor sesuai konteks (tanpa global di halaman web) ---------- */

const api = {
  version: KABUT_VERSION,
  makeRng, rngInt, hash32, hex8, clamp255, pick,
  computeDomainSeed, osFamilyFromUA, normDomain, domainMatches,
  buildProfile, buildChUaHeader, buildHighEntropy, buildSpoofValues,
  buildPermissionStates, PERM_FIXED, PERM_SEEDABLE, PERM_FOLLOW_NOTIF,
  makeCanvasNoiseTable, canvasNoiseAt, noiseImageData,
  makeAudioNoiseTable, makeByteNoiseTable, audioNoiseAt,
  makeRectNoise, makeTextEps, makePermutation,
  parseCandidate, dropCandidateStr, sanitizeSdpText,
  DEFAULT_CONFIG, normalizeSettings, mergeDeep,
  CANVAS_AMP, AUDIO_AMP, SCREEN_POOL, CORES_POOL, MEM_POOL,
  GPU_POOLS, PLATFORM_VERSION_POOLS, SAMPLE_RATE_POOL, JS_HEAP_LIMIT_POOL,
  AUDIO_BASE_LATENCY_POOL, AUDIO_OUTPUT_LATENCY_POOL,
  WGPU_VENDOR_POOL, WGPU_LIMITS_SPOOF, WGPU_COMMON_FEATURES,
  WEBGL_EXT_OPTIONAL,
  evalMediaResolution, buildWorkerPrelude,
  makeStealthKit: makeStealthKit, nativizeShared: nativizeShared,
  makeShim: makeShim, makeBoundProxy: makeBoundProxy
};

const hasModule = (typeof module === 'object' && module && typeof module.exports === 'object');
const inSW = (typeof importScripts === 'function');
const isExtPage = (typeof location === 'object' && location && location.protocol === 'chrome-extension:');
const isWebPage = (typeof window === 'object' && window && typeof location === 'object' &&
  (location.protocol === 'https:' || location.protocol === 'http:'));

if (hasModule) {
  module.exports = api;
} else if (inSW) {
  self.kabutCore = api;
} else if (isExtPage) {
  window.kabutCore = api;
} else if (isWebPage) {
  try { bootInPage(window); } catch (e) { /* diam */ }
}

})();

