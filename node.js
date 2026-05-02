/**
 * CodePad — app.js
 * Features:
 *   - User-defined passkeys (with real-time availability check)
 *   - "Suggest" button for random passkeys
 *   - Offline-first: saves to localStorage when offline, syncs when back online
 *   - Auto-load from URL hash
 */

// ── Config ──────────────────────────────────────────────────────────────
const API_BASE = window.location.origin;
const LOCAL_STORAGE_PREFIX = 'codepad_paste_';

// ── DOM ──────────────────────────────────────────────────────────────────
const codeInput        = document.getElementById('code-input');
const langSelect       = document.getElementById('lang-select');
const expirySelect     = document.getElementById('expiry-select');
const saveBtn          = document.getElementById('save-btn');
const saveResult       = document.getElementById('save-result');
const passkeyDisplay   = document.getElementById('passkey-display');
const copyKeyBtn       = document.getElementById('copy-key-btn');
const saveTimestamp    = document.getElementById('save-timestamp');
const saveSource       = document.getElementById('save-source');
const saveError        = document.getElementById('save-error');

const passkeyDefine    = document.getElementById('passkey-define');
const suggestKeyBtn    = document.getElementById('suggest-key-btn');

const passkeyInput     = document.getElementById('passkey-input');
const loadBtn          = document.getElementById('load-btn');
const loadError        = document.getElementById('load-error');
const codeOutput       = document.getElementById('code-output');
const codeDisplay      = document.getElementById('code-display');
const outputLangBadge  = document.getElementById('output-lang-badge');
const outputTimestamp  = document.getElementById('output-timestamp');
const outputSourceBadge= document.getElementById('output-source-badge');
const copyCodeBtn      = document.getElementById('copy-code-btn');
const lineCount        = document.getElementById('line-count');
const loader           = document.getElementById('loader');
const toast            = document.getElementById('toast');
const offlineBanner    = document.getElementById('offline-banner');
const statusDot        = document.getElementById('status-dot');
const offlineLoadNotice= document.getElementById('offline-load-notice');
const localPastesPanel = document.getElementById('local-pastes-panel');
const localPastesList  = document.getElementById('local-pastes-list');

// ── Online/Offline Detection ─────────────────────────────────────────────
function updateOnlineStatus() {
  const online = navigator.onLine;
  offlineBanner.classList.toggle('hidden', online);
  offlineLoadNotice.classList.toggle('hidden', online);
  statusDot.classList.toggle('offline', !online);
  statusDot.title = online ? 'Online' : 'Offline';
  renderLocalPastes();
}

window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ── Local Storage Helpers ────────────────────────────────────────────────
function saveLocal(passkey, data) {
  try {
    localStorage.setItem(LOCAL_STORAGE_PREFIX + passkey, JSON.stringify(data));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}

function loadLocal(passkey) {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_PREFIX + passkey);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function getAllLocalPasskeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LOCAL_STORAGE_PREFIX)) {
      keys.push(k.replace(LOCAL_STORAGE_PREFIX, ''));
    }
  }
  return keys;
}

function renderLocalPastes() {
  const keys = getAllLocalPasskeys();
  if (keys.length === 0) {
    hide(localPastesPanel);
    return;
  }
  show(localPastesPanel);
  localPastesList.innerHTML = '';
  keys.forEach(key => {
    const data = loadLocal(key);
    const li = document.createElement('li');
    li.innerHTML = `
      <button class="local-paste-btn" data-key="${key}">
        <code>${key}</code>
        <span class="local-paste-lang">${data?.language || ''}</span>
        <span class="local-paste-time">${data?.saved_at ? formatTime(new Date(data.saved_at)) : ''}</span>
        ${!navigator.onLine ? '<span class="local-badge">local</span>' : ''}
      </button>
    `;
    li.querySelector('.local-paste-btn').addEventListener('click', () => {
      passkeyInput.value = key;
      loadCode();
    });
    localPastesList.appendChild(li);
  });
}

// ── Line counter ─────────────────────────────────────────────────────────
codeInput.addEventListener('input', () => {
  const lines = codeInput.value.split('\n').length;
  lineCount.textContent = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
});

// Tab key → 2 spaces
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = codeInput.selectionStart, end = codeInput.selectionEnd;
    codeInput.value = codeInput.value.substring(0, s) + '  ' + codeInput.value.substring(end);
    codeInput.selectionStart = codeInput.selectionEnd = s + 2;
  }
});

// ── Passkey Field: Real-time Availability Check ───────────────────────────
let availCheckTimer = null;
const availStatus = document.createElement('span');
availStatus.className = 'avail-status';
passkeyDefine.parentElement.after(availStatus);

passkeyDefine.addEventListener('input', () => {
  clearTimeout(availCheckTimer);
  const val = passkeyDefine.value.trim();
  if (!val || val.length < 3) {
    availStatus.textContent = '';
    return;
  }

  availCheckTimer = setTimeout(async () => {
    if (!navigator.onLine) {
      const localExists = loadLocal(val.toLowerCase()) !== null;
      availStatus.textContent = localExists ? '⚠ Taken locally' : '✓ Available locally';
      availStatus.className   = 'avail-status ' + (localExists ? 'taken' : 'free');
      return;
    }
    try {
      const res  = await fetch(`${API_BASE}/check/${encodeURIComponent(val)}`);
      const data = await res.json();
      if (data.available === true) {
        availStatus.textContent = '✓ Available';
        availStatus.className   = 'avail-status free';
      } else if (data.available === false) {
        availStatus.textContent = data.reason ? `⚠ ${data.reason}` : '✗ Already taken';
        availStatus.className   = 'avail-status taken';
      } else {
        availStatus.textContent = '';
      }
    } catch {
      availStatus.textContent = '';
    }
  }, 500);
});

// ── Suggest Passkey Button ───────────────────────────────────────────────
suggestKeyBtn.addEventListener('click', async () => {
  if (!navigator.onLine) {
    // Generate locally
    passkeyDefine.value = Math.random().toString(36).slice(2, 10);
    passkeyDefine.dispatchEvent(new Event('input'));
    return;
  }
  try {
    suggestKeyBtn.disabled = true;
    suggestKeyBtn.textContent = '…';
    const res  = await fetch(`${API_BASE}/suggest-passkey`);
    const data = await res.json();
    passkeyDefine.value = data.passkey || '';
    passkeyDefine.dispatchEvent(new Event('input'));
  } catch {
    passkeyDefine.value = Math.random().toString(36).slice(2, 10);
  } finally {
    suggestKeyBtn.disabled = false;
    suggestKeyBtn.textContent = '↺ Suggest';
  }
});

// ── Save Code ────────────────────────────────────────────────────────────
saveBtn.addEventListener('click', async () => {
  const passkey = passkeyDefine.value.trim();
  const code    = codeInput.value.trim();
  const lang    = langSelect.value;
  const expiry  = expirySelect.value;

  // Validate passkey format
  if (!passkey) {
    showError(saveError, 'Please enter a passkey first.');
    return;
  }
  if (!/^[a-zA-Z0-9_\-]{3,32}$/.test(passkey)) {
    showError(saveError, 'Passkey must be 3–32 characters: letters, numbers, hyphens, underscores only.');
    return;
  }
  if (!code) {
    showError(saveError, 'Please enter some code before saving.');
    return;
  }

  setLoading(saveBtn, true);
  hide(saveResult);
  hide(saveError);

  const payload = { passkey: passkey.toLowerCase(), code, language: lang, expiry };
  const savedAt = new Date().toISOString();

  // ── Offline: save to localStorage ──────────────────
  if (!navigator.onLine) {
    const existing = loadLocal(passkey.toLowerCase());
    if (existing) {
      showError(saveError, `Passkey '${passkey}' is already taken locally. Choose another.`);
      setLoading(saveBtn, false);
      return;
    }
    saveLocal(passkey.toLowerCase(), { code, language: lang, saved_at: savedAt, offline: true });
    passkeyDisplay.textContent = passkey.toLowerCase();
    saveTimestamp.textContent  = `Saved locally at ${formatTime(new Date(savedAt))}`;
    saveSource.textContent     = '📦 Saved offline — will sync when online';
    saveSource.style.color     = 'var(--accent2)';
    show(saveResult);
    showToast('Saved locally ✓');
    renderLocalPastes();
    setLoading(saveBtn, false);
    return;
  }

  // ── Online: save to server ─────────────────────────
  try {
    const response = await fetch(`${API_BASE}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to save code.');
    }

    // Also cache locally for offline access later
    saveLocal(passkey.toLowerCase(), { code, language: lang, saved_at: data.saved_at || savedAt });

    passkeyDisplay.textContent = data.passkey || passkey.toLowerCase();
    saveTimestamp.textContent  = `Saved at ${formatTime(new Date(data.saved_at || savedAt))}`;
    saveSource.textContent     = '☁ Saved to server';
    saveSource.style.color     = 'var(--accent)';
    show(saveResult);
    showToast('Code saved! ✓');
    renderLocalPastes();
    availStatus.textContent = '';

  } catch (err) {
    showError(saveError, err.message);
  } finally {
    setLoading(saveBtn, false);
  }
});

// ── Copy passkey ─────────────────────────────────────────────────────────
copyKeyBtn.addEventListener('click', () => {
  copyToClipboard(passkeyDisplay.textContent, 'Passkey copied!');
});

// ── Load Code ────────────────────────────────────────────────────────────
loadBtn.addEventListener('click', () => loadCode());
passkeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadCode();
});

async function loadCode() {
  const passkey = passkeyInput.value.trim().toLowerCase();

  if (!passkey) {
    showError(loadError, 'Please enter a passkey.');
    return;
  }

  setLoading(loadBtn, true);
  hide(loadError);
  hide(codeOutput);
  show(loader);

  // ── Try local first when offline ───────────────────
  if (!navigator.onLine) {
    const local = loadLocal(passkey);
    hide(loader);
    if (local) {
      renderCode(local.code, local.language || 'plaintext', local.saved_at, '📦 local');
    } else {
      showError(loadError, 'Offline and no local copy found for that passkey.');
    }
    setLoading(loadBtn, false);
    return;
  }

  // ── Online: try server, fallback to local ──────────
  try {
    const response = await fetch(`${API_BASE}/load/${encodeURIComponent(passkey)}`);
    const data     = await response.json();

    hide(loader);

    if (!response.ok) {
      // Try local cache before giving up
      const local = loadLocal(passkey);
      if (local) {
        renderCode(local.code, local.language || 'plaintext', local.saved_at, '📦 local cache');
        showToast('Loaded from local cache');
      } else {
        throw new Error(data.error || 'Code not found. Check your passkey.');
      }
      return;
    }

    // Cache to local for offline use
    saveLocal(passkey, { code: data.code, language: data.language, saved_at: data.saved_at });
    renderCode(data.code, data.language || 'plaintext', data.saved_at, '☁ server');
    showToast('Code loaded! ✓');

  } catch (err) {
    hide(loader);
    showError(loadError, err.message);
  } finally {
    setLoading(loadBtn, false);
  }
}

function renderCode(code, lang, savedAt, source) {
  codeDisplay.textContent     = code;
  outputLangBadge.textContent = lang;
  outputTimestamp.textContent = savedAt ? `Saved ${formatTime(new Date(savedAt))}` : '';
  outputSourceBadge.textContent = source;
  codeDisplay.className       = `hljs language-${lang}`;
  hljs.highlightElement(codeDisplay);
  show(codeOutput);
}

// ── Copy loaded code ──────────────────────────────────────────────────────
copyCodeBtn.addEventListener('click', () => {
  copyToClipboard(codeDisplay.textContent, 'Code copied!');
});

// ── Helpers ──────────────────────────────────────────────────────────────
function copyToClipboard(text, message = 'Copied!') {
  navigator.clipboard.writeText(text).then(() => showToast(message)).catch(() => {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast(message);
  });
}

let toastTimer = null;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function showError(el, message) {
  el.textContent = `⚠ ${message}`;
  show(el);
}

function setLoading(btn, isLoading) {
  btn.disabled = isLoading;
  btn.classList.toggle('loading', isLoading);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function formatTime(date) {
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// ── Auto-load from URL hash ───────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderLocalPastes();
  const hash = window.location.hash.slice(1);
  if (hash) {
    passkeyInput.value = hash;
    loadCode();
    document.getElementById('load-panel').scrollIntoView({ behavior: 'smooth' });
  }
});