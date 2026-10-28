# Argo Submit — Bulk Workflow Submission

A Chrome extension that adds a **bulk submit** button to the Argo Workflows web UI. Type a list of `--from workflowtemplate/…` commands, pick regions/clusters, and submit them one after another — all from the browser, no CLI needed.

## How it works

The extension injects a "**Submit Bulk**" button next to the normal "Submit New Workflow" button on any Argo Workflows namespace page. Clicking it opens a modal where you can:

1. Paste or type one `argo submit`-style command per line.
2. Select regions and clusters from the pickers (auto-detected from your `helm-create-*` templates).
3. Click **Validate** (dry-run) or **Run** to submit each workflow in sequence.

Each workflow must finish before the next starts. Results are shown inline.

> **No `argo` CLI, no native host, no token setup required for bulk submit.**  
> The extension talks to the Argo API same-origin, using the session cookie from the page you're logged into.

---

## Installation

### Extension (required for bulk submit)

1. Clone this repo.
2. Load the `extension/` directory as an unpacked extension in Chrome:
   - Go to `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** and select the `extension/` folder
3. Navigate to your Argo Workflows UI and log in. The **Submit Bulk** button appears next to "Submit New Workflow".

> Chrome ≥ 110 is required (Manifest V3).

---

## Usage

### Quick start

1. Open your Argo Workflows namespace page (e.g. `https://argo.example.com/workflows/<namespace>`).
2. Click **Submit Bulk** (next to the "Submit New Workflow" button).
3. In the textarea, type your commands, one per line:

   ```
   --from workflowtemplate/helm-create-kyverno -p region=$region -p clusterName=$cluster -p dryRun=false
   --from workflowtemplate/helm-create-kyverno-addons -p region=$region -p clusterName=$cluster -p dryRun=false
   ```

4. The extension automatically detects regions and clusters from your `helm-create-*` templates. Tick the ones you want.
5. Click **Validate** to dry-run every line, or **Run** to submit.

   Each line runs once per combination of the variables it uses (one cluster finishes before the next starts).

### Supported command syntax

Each line follows the `argo submit` CLI format:

```
--from workflowtemplate/<name> -p <name>=<value> [-p ...]
```

| Part | Description |
|---|---|
| `--from workflowtemplate/<name>` | The workflow template to submit (required) |
| `-p` / `--parameter` | Parameters as `name=value` |
| `--wait` / `--watch` | Ignored — the runner always waits for completion |
| `-n` / `--namespace` | **Not allowed** — the namespace is taken from the page |
| `#` at start of line | Comment line (ignored) |
| `\` at end of line | Backslash continuation joins with the next line |
| `$region`, `${region}` | Replaced by the selected region(s) |
| `$cluster`, `$clusterName`, `${clusterName}` | Replaced by the selected cluster(s) |

### Variable substitution

- `$region` and `$cluster` (or `$clusterName`, `${clusterName}`) are replaced with the values ticked in the pickers.
- If you have 2 regions and 3 clusters ticked, a line using both runs 6 times (once per combination), a line using only `$region` runs 2 times, and a line using neither runs once.
- If no picker values are available (e.g. no `helm-create-*` template with a cluster list), you can hardcode values instead.

### On-failure behaviour

- **stop the batch**: if a workflow fails, the remaining lines are skipped.
- **continue**: keep going regardless.

---

## Optional: Token sync for the `argo` CLI

The extension can also read your Argo SSO session cookie and pass it to the `argo` CLI, so you can run `argo` from your terminal without re-authenticating.

### How it works

1. The extension reads the `authorization` cookie from the Argo UI.
2. It sends the token to a **native messaging host** (`com.jprats.argo_submit`).
3. The native host writes `~/.cache/argo-sso/env` with the environment variables that `argo` needs.

### Setup

1. Install the native host (you'll need to create the host manifest — see `lib.js` for the host name `com.jprats.argo_submit`).
2. In the extension's **Settings** page, set your Argo server host and tick "Keep `~/.cache/argo-sso/env` updated".
3. Click **Write to ~/.cache/argo-sso/env** from the toolbar popup to test.

---

## Development

### Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker: cookie sync, bulk script registration |
| `lib.js` | Shared library: cookie reading, settings, native messaging, bulk script helpers |
| `parse.js` | Parser for `argo submit`-style command lines (also usable in Node) |
| `bulk.js` | Content script: injects "Submit Bulk" modal |
| `popup.html` / `popup.js` | Toolbar popup UI for token actions |
| `popup-bulk.js` | Popup logic for enabling/disabling bulk per site |
| `options.html` / `options.js` | Settings page for host configuration |

### Tests

```bash
node --test test/parse.test.js
```
