/* KABUT options — pengaturan lanjutan v3 (surface baru + diagnostik) */
(function () {
'use strict';

const CORE = window.kabutCore;
const $ = function (id) { return document.getElementById(id); };
let cfg = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.style.display = 'none'; }, 2600);
}

function send(msg) {
  return new Promise(function (res) {
    chrome.runtime.sendMessage(msg, function (r) {
      void chrome.runtime.lastError;
      res(r || { ok: false });
    });
  });
}

function patch(p) {
  return send({ type: 'kabut-set-settings', patch: p }).then(function (r) {
    if (r && r.cfg) { cfg = CORE.normalizeSettings(r.cfg); render(); }
    return r;
  });
}

/* ---- preset ---- */
function presetPatch(name) {
  if (name === 'seimbang') {
    /* v3: seimbang juga mematikan WebGPU (risiko kompat aplikasi WebGPU). */
    return { preset: 'seimbang', surfaces: { screen: false, voices: false, media: false, webgpu: false, canvas: 'noise' } };
  }
  return { preset: 'paranoid', surfaces: { screen: true, voices: true, media: true, webgpu: true, canvas: 'noise' } };
}

/* ---- render ---- */
function render() {
  if (!cfg) return;
  $('enabled').checked = cfg.enabled !== false;
  $('preset').value = cfg.preset;
  $('headers').value = cfg.headers;
  $('profile').value = cfg.profile;
  $('webrtc').value = cfg.webrtc;
  $('canvasMode').value = cfg.surfaces.canvas;
  $('canvasStrength').value = cfg.surfaces.canvasStrength;
  const S = cfg.surfaces;
  const map = { webgl: S.webgl, webgpu: S.webgpu !== false, hwapi: S.hwapi !== false, workers: S.workers !== false,
    audio: S.audio, rects: S.rects, fonts: S.fonts, screen: S.screen, hardware: S.hardware, memory: S.memory,
    touch: S.touch, devices: S.devices, battery: S.battery, network: S.network, storage: S.storage,
    keyboard: S.keyboard, plugins: S.plugins, uaData: S.uaData, media: S.media, voices: S.voices, permissions: S.permissions };
  Object.keys(map).forEach(function (k) {
    const el = $('s-' + k);
    if (el) el.checked = !!map[k];
  });
  $('allowlist').value = (cfg.allowlist || []).join('\n');
  renderUaPreview();
}

function renderUaPreview() {
  try {
    const realUA = navigator.userAgent;
    const prof = CORE.buildProfile(realUA, null, cfg.profile);
    const chUa = CORE.buildChUaHeader(prof);
    $('uaPreview').textContent =
      'UA       : ' + prof.ua + '\n' +
      'Platform : ' + prof.platform + '   (client-hints: ' + prof.chPlatform + ')\n' +
      'Sec-CH-UA: ' + chUa;
  } catch (e) {
    $('uaPreview').textContent = 'gagal memuat pratinjau';
  }
}

function renderRealFp() {
  try {
    const nav = navigator;
    let uad = 'tidak tersedia';
    if (nav.userAgentData) {
      uad = nav.userAgentData.platform + ' | brands: ' + (nav.userAgentData.brands || []).map(function (b) { return b.brand + ' ' + b.version; }).join(', ');
    }
    $('realFp').textContent =
      'userAgent         : ' + nav.userAgent + '\n' +
      'platform          : ' + nav.platform + '\n' +
      'hardwareConcurr.  : ' + nav.hardwareConcurrency + '\n' +
      'deviceMemory      : ' + nav.deviceMemory + '\n' +
      'userAgentData     : ' + uad + '\n' +
      'language          : ' + nav.language + '  | languages: ' + JSON.stringify(nav.languages) + '\n' +
      'timezone          : ' + Intl.DateTimeFormat().resolvedOptions().timeZone + '\n' +
      'screen            : ' + screen.width + 'x' + screen.height + ' @dpr ' + window.devicePixelRatio + '\n' +
      'orientation       : ' + (screen.orientation ? screen.orientation.type + ' @' + screen.orientation.angle : '-') + '\n' +
      'devicePixelRatio  : ' + window.devicePixelRatio + '\n' +
      'touchPoints       : ' + nav.maxTouchPoints + '\n' +
      'plugins           : ' + (nav.plugins ? nav.plugins.length : '-') + ' entri';
  } catch (e) {
    $('realFp').textContent = 'gagal membaca';
  }
}

async function renderDiag() {
  try {
    const r = await send({ type: 'kabut-get-status' });
    if (r && r.ok) {
      const dnr = r.dnr || {};
      const lines = [
        'Versi inti        : ' + (r.version || CORE.version),
        'Secret identitas  : ' + (r.hasSecret ? 'ADA (128-bit lokal)' : 'BELUM ADA'),
        'WebRTC jaringan   : ' + r.webrtcPolicy,
        'Ruleset DNR aktif : ' + ((dnr.statics || []).join(', ') || '(tidak ada)'),
        'Session rules     : ' + (dnr.sessionRules || 0) + (dnr.sessionRules ? ' (override UA profil)' : ''),
        'Profil            : ' + (dnr.profile || cfg.profile),
        'Mode header       : ' + (dnr.headers || cfg.headers)
      ];
      $('diagStatus').textContent = lines.join('\n');
    } else {
      $('diagStatus').textContent = 'service worker tidak merespons';
    }
  } catch (e) {
    $('diagStatus').textContent = 'gagal memuat diagnostik';
  }
}

/* ---- events ---- */
$('enabled').addEventListener('change', function () { patch({ enabled: this.checked }); });
$('preset').addEventListener('change', function () {
  patch(presetPatch(this.value)).then(function () { toast('Preset "' + ($('preset').value) + '" diterapkan — muat ulang tab yang terbuka.'); });
});
$('headers').addEventListener('change', function () { patch({ headers: this.value }); });
$('profile').addEventListener('change', function () { patch({ profile: this.value }).then(function () { toast('Profil diubah — muat ulang halaman.'); }); });
$('webrtc').addEventListener('change', function () { patch({ webrtc: this.value }); });
$('canvasMode').addEventListener('change', function () { patch({ surfaces: { canvas: this.value } }); });
$('canvasStrength').addEventListener('change', function () { patch({ surfaces: { canvasStrength: this.value } }); });

const SURF = ['webgl', 'webgpu', 'workers', 'hwapi', 'audio', 'rects', 'fonts', 'screen', 'hardware', 'memory', 'touch', 'devices', 'battery', 'network', 'storage', 'keyboard', 'plugins', 'uaData', 'media', 'voices', 'permissions'];
SURF.forEach(function (k) {
  const el = $('s-' + k);
  if (el) el.addEventListener('change', function () {
    const o = {}; o[k] = this.checked;
    patch({ surfaces: o });
  });
});

$('allowlist').addEventListener('change', function () {
  const list = this.value.split(/[\n,]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s && s.length < 254; });
  patch({ allowlist: list });
});

$('rerollGlobal').addEventListener('click', async function () {
  const r = await send({ type: 'kabut-reroll-global' });
  toast(r && r.ok ? 'Identitas global baru dibuat — muat ulang semua tab.' : 'Gagal.');
});

$('exportBtn').addEventListener('click', function () {
  $('ioArea').value = JSON.stringify(cfg, null, 2);
  $('ioArea').select();
  toast('Pengaturan diekspor ke area JSON di bawah.');
});

$('importBtn').addEventListener('click', async function () {
  try {
    const parsed = JSON.parse($('ioArea').value);
    const r = await send({ type: 'kabut-set-settings', patch: CORE.normalizeSettings(parsed) });
    if (r && r.ok) { cfg = CORE.normalizeSettings(r.cfg); render(); toast('Pengaturan diimpor.'); }
    else toast('Impor gagal.');
  } catch (e) { toast('JSON tidak valid.'); }
});

$('resetBtn').addEventListener('click', async function () {
  const r = await send({ type: 'kabut-set-settings', patch: CORE.normalizeSettings({}) });
  if (r && r.ok) { cfg = CORE.normalizeSettings(r.cfg); render(); toast('Direset ke default (paranoid).'); }
});

$('wipeBtn').addEventListener('click', async function () {
  if (!window.confirm('Hapus SELURUH data Kabut (pengaturan + identitas)? Semua tab harus dimuat ulang.')) return;
  const r = await send({ type: 'kabut-wipe' });
  toast(r && r.ok ? 'Semua data Kabut dihapus & dibangun ulang — muat ulang tab.' : 'Gagal.');
  load();
});

$('refreshDiag').addEventListener('click', renderDiag);

const testBtns = document.querySelectorAll('button[data-url]');
for (let i = 0; i < testBtns.length; i++) {
  testBtns[i].addEventListener('click', function () {
    chrome.tabs.create({ url: this.getAttribute('data-url') });
  });
}

/* Live-update dari popup/perubahan lain. */
try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.kabut) return;
    try { cfg = CORE.normalizeSettings(changes.kabut.newValue || {}); render(); } catch (e) {}
  });
} catch (e) {}

/* ---- init ---- */
async function load() {
  const r = await send({ type: 'kabut-get-status' });
  if (r && r.ok) cfg = CORE.normalizeSettings(r.cfg || {});
  else cfg = CORE.normalizeSettings({});
  render();
  renderRealFp();
  renderDiag();
}
load();
})();
