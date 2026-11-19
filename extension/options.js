import { getSettings, cleanHost } from './lib.js';

const $ = id => document.getElementById(id);
const origin = h => `https://${h}/*`;
const parseHosts = text => [...new Set(text.split('\n').map(cleanHost).filter(Boolean))];

async function showStatus(hosts) {
  const granted = await Promise.all(hosts.map(h => chrome.permissions.contains({ origins: [origin(h)] })));
  $('hostStatus').replaceChildren(...hosts.map((h, i) => {
    const li = document.createElement('li');
    li.textContent = `${granted[i] ? '✓' : '✗ not granted'}  ${h}`;
    li.className = granted[i] ? 'ok' : 'bad';
    return li;
  }));
}

const s = await getSettings();
$('host').value = s.host;
$('writeFile').checked = s.writeFile;
$('syncHosts').value = (s.syncHosts || []).join('\n');
showStatus(s.syncHosts || []);

$('save').onclick = async () => {
  const host = cleanHost($('host').value);
  const syncHosts = parseHosts($('syncHosts').value);
  $('host').value = host;
  $('syncHosts').value = syncHosts.join('\n');
  // Reading the session cookies needs access to those hosts; must be requested from this click.
  const origins = [...new Set([host, ...syncHosts].filter(Boolean).map(origin))];
  const granted = !origins.length || await chrome.permissions.request({ origins });
  await chrome.storage.sync.set({ host, writeFile: $('writeFile').checked, syncHosts });
  $('msg').textContent = granted ? 'Saved.' : 'Saved, but host access was not granted.';
  showStatus(syncHosts);
};
