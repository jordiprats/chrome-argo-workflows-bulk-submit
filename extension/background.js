import { COOKIE_NAME, getSettings, readToken, cookieMatchesHost, pushToHost, grantedSyncHosts, cleanHost, syncBulk } from './lib.js';

// Keep ~/.cache/argo-sso/tokens/<host>.json fresh for every granted sync host (read by terminal
// tools), and ~/.cache/argo-sso/env for the main host when "writeFile" is on (argo CLI). Pushed whenever the
// session cookie changes and once at browser start.
async function syncHost(host, removed = false) {
  const { host: main, writeFile } = await getSettings();
  const env = writeFile && cleanHost(main) === host;
  try {
    if (removed) return void (await pushToHost(host, null));
    const t = await readToken(host);
    await pushToHost(host, t ? t.token : null, { expires: t?.expires ?? null, env: env && !!t });
  } catch (e) {
    console.warn(`argo-submit: could not sync ${host} (native host not installed? run host/install.sh)`, e);
  }
}

async function sync() {
  for (const host of await grantedSyncHosts()) await syncHost(host);
}

chrome.cookies.onChanged.addListener(async ({ cookie, removed, cause }) => {
  if (cookie.name !== COOKIE_NAME) return;
  // An "overwrite" removal is immediately followed by the new cookie; only react to real removals.
  if (removed && cause === 'overwrite') return;
  for (const host of await grantedSyncHosts()) {
    if (cookieMatchesHost(cookie, host)) syncHost(host, removed);
  }
});

chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
chrome.storage.onChanged.addListener(sync);
chrome.permissions.onAdded.addListener(sync);

// The Shell button (content script, which can't use native messaging) asks for its own host to be synced, so
// opening the shell refreshes ~/.cache/argo-sso/tokens/<host>.json even when the session cookie hasn't changed
// since the browser started. Works for any host the user granted access to, whether or not it is in the options list.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'argo-sync-host' || !sender.url) return;
  let host;
  try { host = new URL(sender.url).host; } catch { return; }
  (async () => {
    if (!(await chrome.permissions.contains({ origins: [`https://${host}/*`] }))) {
      return sendResponse({ ok: false, error: 'no permission' });
    }
    await syncHost(host);
    sendResponse({ ok: true, host });
  })();
  return true; // async response
});

// Bulk submit: keep the content-script registrations in step with the sites the user has granted.
chrome.permissions.onAdded.addListener(syncBulk);
chrome.permissions.onRemoved.addListener(syncBulk);
chrome.runtime.onStartup.addListener(syncBulk);
chrome.runtime.onInstalled.addListener(syncBulk);
