import { getSettings, readToken, checkToken, envText, pushToHost } from './lib.js';

const $ = id => document.getElementById(id);
const say = (text, cls = '') => { $('status').textContent = text; $('status').className = cls; };
const note = text => { $('msg').firstChild.textContent = text; };

$('options').onclick = () => chrome.runtime.openOptionsPage();

const { host } = await getSettings();
if (!host) {
  say('No host configured. Open Settings.', 'bad');
  $('open').disabled = true;
} else {
  $('open').onclick = () => chrome.tabs.create({ url: `https://${host}/workflows` });

  let t = null;
  try { t = await readToken(host); } catch { /* no permission yet */ }

  if (!t) {
    say(`No session cookie for ${host}. Log in first.`, 'bad');
  } else {
    const state = await checkToken(host, t.token);
    if (state === 'expired') {
      say('Session expired. Log in again.', 'bad');
    } else {
      const exp = t.expires ? ` (cookie expires ${new Date(t.expires).toLocaleString()})` : '';
      say(`Session ${state === 'valid' ? 'valid' : 'found (unverified)'}${exp}`, state === 'valid' ? 'ok' : '');
      $('copy').disabled = false;
      $('write').disabled = false;
      $('copy').onclick = async () => {
        await navigator.clipboard.writeText(envText(host, t.token));
        note('Copied. In your shell: eval "$(pbpaste)"');
      };
      $('write').onclick = async () => {
        try {
          const r = await pushToHost(host, t.token, { expires: t.expires, env: true });
          note(r?.ok ? `Wrote ${r.path}` : `Host error: ${r?.error ?? 'no response'}`);
        } catch (e) {
          note(`Native host not reachable: ${e.message}. Run install.sh.`);
        }
      };
    }
  }
}
