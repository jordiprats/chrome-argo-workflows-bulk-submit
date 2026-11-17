export const NATIVE_HOST = 'com.jprats.argo_submit';
export const COOKIE_NAME = 'authorization';

export async function getSettings() {
  return chrome.storage.sync.get({ host: '', writeFile: true });
}

export function cleanHost(input) {
  return (input || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:443$/, '');
}

// The UI stores "Bearer v2:..." (possibly URL-encoded); make sure we always end up with the prefix.
export function normalise(raw) {
  let v = raw;
  try { v = decodeURIComponent(raw); } catch { /* keep raw */ }
  return /^Bearer /i.test(v) ? v : `Bearer ${v}`;
}

export function cookieMatchesHost(cookie, host) {
  const d = cookie.domain.replace(/^\./, '');
  return host === d || host.endsWith(`.${d}`);
}

export async function readToken(host) {
  const c = await chrome.cookies.get({ url: `https://${host}/`, name: COOKIE_NAME });
  if (!c) return null;
  return { token: normalise(c.value), expires: c.expirationDate ? c.expirationDate * 1000 : null };
}

// 'valid' | 'expired' | 'unknown'. Runs from an extension context so host permission bypasses CORS.
export async function checkToken(host, token) {
  try {
    const r = await fetch(`https://${host}/api/v1/userinfo`, { headers: { Authorization: token } });
    if (r.status === 401 || r.status === 403) return 'expired';
    return r.ok ? 'valid' : 'unknown';
  } catch {
    return 'unknown';
  }
}

const q = s => `'${s.replace(/'/g, `'\\''`)}'`;

export function envText(host, token) {
  return [
    `export ARGO_SERVER=${q(`${host}:443`)}`,
    'export ARGO_SECURE=true',
    'export ARGO_HTTP1=true',
    `export ARGO_TOKEN=${q(token)}`,
  ].join('\n');
}

export function pushToHost(host, token) {
  return chrome.runtime.sendNativeMessage(NATIVE_HOST, { host, token });
}

// ---- Bulk submit content script ----
// Registered for every site the user has granted (the popup only asks for the permission; the
// background worker does the registering, because the popup is closed by Chrome's permission prompt).

const BULK_FILES = ['parse.js', 'shell.js', 'bulk.js'];
const BULK_PREFIX = 'bulk:';
const bulkPattern = origin => `${origin}/*`;

// Specific-site grants only (https://host/*); never the wildcard https://*/* or <all_urls>.
export const concreteOrigins = patterns =>
  (patterns || []).filter(p => /^https?:\/\/[^*/]+\/\*$/.test(p)).map(p => p.slice(0, -2));

export async function bulkEnabled(origin) {
  const [reg, granted] = await Promise.all([
    chrome.scripting.getRegisteredContentScripts({ ids: [BULK_PREFIX + origin] }),
    chrome.permissions.contains({ origins: [bulkPattern(origin)] }),
  ]);
  return granted && reg.length > 0;
}

// Make the registered scripts match the granted sites, and inject into tabs already open on a new site.
export async function syncBulk() {
  const granted = new Set(concreteOrigins((await chrome.permissions.getAll()).origins));
  const existing = (await chrome.scripting.getRegisteredContentScripts()).filter(s => s.id.startsWith(BULK_PREFIX));
  const registered = new Set(existing.map(s => s.id.slice(BULK_PREFIX.length)));

  const stale = [...registered].filter(o => !granted.has(o));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale.map(o => BULK_PREFIX + o) });

  // Registrations persist across extension updates, so pick up a changed file list (e.g. a new script).
  const outdated = existing.filter(s => granted.has(s.id.slice(BULK_PREFIX.length)) && s.js?.join() !== BULK_FILES.join());
  if (outdated.length) {
    await chrome.scripting.updateContentScripts(outdated.map(s => ({ id: s.id, js: BULK_FILES })));
  }

  for (const origin of [...granted].filter(o => !registered.has(o))) {
    try {
      await chrome.scripting.registerContentScripts([{
        id: BULK_PREFIX + origin, matches: [bulkPattern(origin)], js: BULK_FILES, runAt: 'document_idle', persistAcrossSessions: true,
      }]);
    } catch (e) {
      console.warn('argo-submit: could not register bulk script for', origin, e);
      continue;
    }
    for (const tab of await chrome.tabs.query({ url: bulkPattern(origin) })) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: BULK_FILES }).catch(() => {});
    }
  }
}

// Must run from a user gesture. Registration happens in the background worker (onAdded -> syncBulk).
export const enableBulk = origin => chrome.permissions.request({ origins: [bulkPattern(origin)] });
export const disableBulk = origin => chrome.permissions.remove({ origins: [bulkPattern(origin)] });
