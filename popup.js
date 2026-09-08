/* KABUT popup — kontrol cepat v3 (status DNR + WebGPU/Worker toggle) */
(function () {
'use strict';

const $ = function (id) { return document.getElementById(id); };
let state = { cfg: null, domain: '', webrtcPolicy: 'unknown', dnr: null };

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(function () { t.style.display = 'none'; }, 2200);
}

function isAllowlisted(domain, list) {
  if (!Array.isArray(list)) return false;
  const d = String(domain || '').toLowerCase();
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i] || '').toLowerCase().replace(/^\./, '');
    if (a && (d === a || d.endsWith('.' + a))) return true;
  }
  return false;
}

function send(msg) {
  return new Promise(function (res) {
    chrome.runtime.sendMessage(msg, function (r) {
      void chrome.runtime.lastError;
      res(r || { ok: false });
    });
  });
}

function patch(patchObj) {
  return send({ type: 'kabut-set-settings', patch: patchObj }).then(function (r) {
    if (r && r.cfg) state.cfg = r.cfg;
    render();
    return r;
  });
}

async function loadStatus() {
  const r = await send({ type: 'kabut-get-status' });
  if (r && r.ok) {
    state.cfg = r.cfg;
    state.webrtcPolicy = r.webrtcPolicy;
    state.dnr = r.dnr;
    if (r.version) $('verLine').textContent = 'Stealth & Anti-Fingerprinting v' + r.version;
  }
  try {
    const tabs = await new Promise(function (res) { chrome.tabs.query({ active: true, currentWindow: true }, res); });
    const url = tabs && tabs[0] && tabs[0].url || '';
    if (/^https?:/i.test(url)) {
      state.domain = new URL(url).hostname;
    } else {
      state.domain = '';
    }
  } catch (e) { state.domain = ''; }
  render();
}

function render() {
  const cfg = state.cfg;
  if (!cfg) return;
  const active = cfg.enabled !== false;
  const siteOn = state.domain ? !isAllowlisted(state.domain, cfg.allowlist) : true;

  $('badge').textContent = active ? 'AKTIF' : 'MATI';
  $('badge').className = 'badge ' + (active ? 'on' : 'off');
  $('master').checked = active;
  $('domainToggle').checked = siteOn;
  $('domainToggle').disabled = !state.domain;
  $('domain').textContent = state.domain ? state.domain : '(halaman ini bukan situs web)';

  $('profile').value = cfg.profile;
  $('webrtc').value = cfg.webrtc;

  const s = cfg.surfaces || {};
  const mini = {
    canvas: s.canvas !== 'off', webgl: !!s.webgl, webgpu: s.webgpu !== false,
    workers: s.workers !== false, audio: !!s.audio, screen: !!s.screen,
    hardware: !!s.hardware, rects: !!s.rects
  };
  const nodes = document.querySelectorAll('.mini');
  for (let i = 0; i < nodes.length; i++) {
    const k = nodes[i].getAttribute('data-key');
    nodes[i].className = 'mini' + (mini[k] ? ' on' : '');
  }

  const dnr = state.dnr || {};
  const headerOn = (dnr.statics || []).indexOf('core_headers') >= 0 || (dnr.statics || []).indexOf('strict_headers') >= 0;
  $('foot').innerHTML =
    '<b>WebRTC (jaringan):</b> ' + (state.webrtcPolicy === 'disable_non_proxied_udp' ? '<span class="ok">terkunci (disable_non_proxied_udp)</span>'
      : state.webrtcPolicy === 'unavailable' ? 'tidak tersedia di browser ini — lapisan JS tetap aktif'
      : String(state.webrtcPolicy)) +
    '<br><b>Sanitasi header:</b> ' + (headerOn
      ? '<span class="ok">AKTIF</span> (' + ((dnr.statics || []).join(', ') || '-') + (dnr.sessionRules ? ' + ' + dnr.sessionRules + ' rule profil' : '') + ')'
      : (cfg.headers === 'none' ? 'nonaktif (pengaturan Anda)' : 'belum aktif — muat ulang browser')) +
    '<br><b>Zona waktu &amp; bahasa:</b> asli (sesuai preferensi Anda)';
}

$('master').addEventListener('change', function () {
  patch({ enabled: $('master').checked });
});

$('domainToggle').addEventListener('change', function () {
  if (!state.domain) return;
  const on = $('domainToggle').checked;
  const list = ((state.cfg && state.cfg.allowlist) || []).slice();
  const idx = list.indexOf(state.domain);
  if (on && idx >= 0) list.splice(idx, 1);
  if (!on && idx < 0) list.push(state.domain);
  patch({ allowlist: list });
  toast(on ? 'Proteksi diaktifkan untuk situs ini (muat ulang halaman).' : 'Situs ini dipercaya — proteksi dimatikan (muat ulang).');
});

$('profile').addEventListener('change', function () {
  patch({ profile: $('profile').value });
  toast('Profil diubah. Muat ulang halaman untuk efek penuh.');
});

$('webrtc').addEventListener('change', function () {
  patch({ webrtc: $('webrtc').value });
});

const nodes = document.querySelectorAll('.mini');
for (let i = 0; i < nodes.length; i++) {
  nodes[i].addEventListener('click', function () {
    const k = this.getAttribute('data-key');
    const s = state.cfg.surfaces;
    if (k === 'canvas') patch({ surfaces: { canvas: s.canvas === 'off' ? 'noise' : 'off' } });
    else if (k === 'webgpu') patch({ surfaces: { webgpu: s.webgpu === false } });
    else if (k === 'workers') patch({ surfaces: { workers: s.workers === false } });
    else patch({ surfaces: (function () { const o = {}; o[k] = !s[k]; return o; })() });
  });
}

$('reroll').addEventListener('click', async function () {
  if (!state.domain) { toast('Buka dulu sebuah situs web.'); return; }
  const r = await send({ type: 'kabut-reroll-domain', domain: state.domain });
  toast(r && r.ok ? 'Seed domain diacak ulang — muat ulang halaman.' : 'Gagal mengacak seed.');
});

$('test').addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://abrahamjuliot.github.io/creepjs/' });
});

$('testWebGpu').addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://browserleaks.com/webgpu' });
});

$('options').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
});

/* Live-update saat pengaturan berubah dari halaman opsi. */
try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.kabut) return;
    loadStatus();
  });
} catch (e) {}

loadStatus();
})();
