# Argo Workflows — Bulk Submission

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

## Shell (kubectl and aws)

Next to **Submit Bulk** there is a **Shell** button: a terminal-style window that runs commands through workflow templates. Lines starting with `aws` run the `admin-aws` template (from `pi-wf-account-provisioning-aws`); anything else is kubectl and runs `admin-kubectl` (from `pi-wf-kubernetes-aws`).

- Pick the region, cluster and role in the title bar (choices come from the templates' parameter enums; the role list is the union of both, and a role a template doesn't offer, like `ssg-deploy` for kubectl, is refused up front), type a command and press Enter. The leading `kubectl` is optional (`get pods -A` works) and `k` is an alias for it (`k get pods` is sent to the workflow as `kubectl get pods`).
- `aws` commands run in the account's own `admin-aws` workflow: region and cluster do not apply to them. `readonly` needs a command like `aws s3 ls` with none of `< > ; & |`; `deploy` has no restriction.
- While the workflow runs you only see a spinner with its state (submitting, pending, running). Then the `kubectl-output` / `aws-output` artifact is printed. If the command fails, the stderr from the pod log is printed instead, with a link to the workflow.
- `readonly` role rejects the characters `< > ; & |`. `deploy` removes that restriction and is red-prompted; it needs the `admins` group like the template itself.
- You can keep typing while a command runs. Pressing Enter queues the next one instead of submitting it; it only starts once everything queued ahead of it has finished. Queued commands are listed above the input, each in its own editable box, with buttons to move it up/down, jump it to the front, or remove it — all before its turn comes; nothing already running can be edited or stopped that way. `Ctrl+C` drops anything still queued as well as stopping the current wait.
- `Ctrl+D` sends the running command to the background: the prompt and the queue move on straight away, and the command's output is printed under a `[n] done: <command>` line when its workflow finishes (output from later commands may appear in between). The title bar shows `bg: <count>` while any are running and `jobs` lists them. `Ctrl+C` only affects the foreground command and leaves background jobs alone; closing the shell stops waiting for them, but the workflows keep running. Pickers are read when a command is submitted, so changing region/cluster/role afterwards doesn't affect jobs already in the background.
- Copy and paste work like a terminal: selecting text in the output copies it automatically ("copied" flashes in the title bar) and puts the cursor back in the input, so you can paste straight away. A paste that lands outside the input is redirected to it.
- `Ctrl+←`/`Ctrl+→`, `Option/Alt+←`/`→` and `Alt+B`/`Alt+F` move the cursor word by word in the command line (add `Shift` to select). On macOS, `Ctrl+←/→` is claimed by Mission Control to switch Spaces, so the page only sees it if you turn those shortcuts off in System Settings → Keyboard → Keyboard Shortcuts → Mission Control; `Option+←/→` always works.
- `Up`/`Down` history, `Ctrl+L` or `clear` to clear, `Ctrl+C` to stop waiting (the workflow keeps running) — or, when nothing is running, to discard what you've typed (it's echoed with `^C`, like a shell prompt; with text selected it still copies), `Esc` to close.
- The button is always shown; if the namespace lacks one of the templates, the terminal says so and the other still works.
- `ns` (also `kubectl ns` / `k ns` — it's never sent to kubectl, which has no such command) lists the cluster's namespaces, numbered, with the current default marked. `ns <name>` sets the default Kubernetes namespace — every kubectl command after that runs as if you'd added `-n <name>`, shown next to the title — and `ns <number>` sets it by picking from the last listing. `ns -` (or `ns none`/`ns default`) clears it. It is added to **every** `kubectl` in the line, so `kubectl get workflow -o name | xargs -I{} kubectl patch {} ...` becomes `kubectl -n <name> get ... | xargs -I{} kubectl -n <name> patch ...`. That covers a `kubectl` after `|`, `&&`, `||`, `;`, `$(...)` or a wrapper such as `xargs`, `watch`, `timeout` or `env`. Each is judged on its own: one that already has `-n`/`--namespace` or `-A`/`--all-namespaces` is left alone, without affecting the others. Anything inside quotes (like a `-p '{...}'` payload) is never touched, and a `kubectl` that is only an argument (`grep kubectl`, `xargs echo kubectl`) isn't counted. This is a text heuristic, not a full shell parser, so unusual constructs (here-docs, `bash -c "..."`, aliases) aren't rewritten — put `-n` on those yourself. This is a client-side convenience only — it has nothing to do with the Argo workflow's own namespace, shown next to it in the title bar.

Every command is a real workflow in the namespace, so it shows up in the workflow list and takes as long as a pod start (typically several seconds).

---

## Optional: Token sync for terminal tools

The extension can copy your Argo SSO session token out of the browser so that terminal tools can use it:

- `~/.cache/argo-sso/tokens/<host>.json` for each host in the options host list, for scripts and tools that call the Argo API (`Authorization: <token>`).
- `~/.cache/argo-sso/env` for the main host, if enabled. It holds `ARGO_SERVER`/`ARGO_TOKEN` for the `argo` CLI.

### How it works

1. The background worker reads the `authorization` cookie for each granted host, at browser start and whenever the cookie changes, so logging in again refreshes it.
2. It sends the token to the **native messaging host** `com.jprats.argo_submit` ([host/argo_sso_host.py](host/argo_sso_host.py)).
3. The host writes the files with mode 0600, inside directories with mode 0700. When a cookie is removed, it deletes that host's token file.

### Setup

1. Run `host/install.sh`. It registers the host for Chrome, Chrome Beta and Chromium. The extension ID is fixed by the `key` in `manifest.json`.
2. Open the extension's **Settings**, add your Argo server hosts (one per line), click **Save and grant access** and approve.
3. Log in to each Argo server. The settings page shows which hosts are granted.

## Development

### Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker: cookie sync, bulk script registration |
| `lib.js` | Shared library: cookie reading, settings, native messaging, bulk script helpers |
| `parse.js` | Parser for `argo submit`-style command lines (also usable in Node) |
| `bulk.js` | Content script: injects the "Submit Bulk" and "Shell" buttons and the bulk modal |
| `shell.js` | kubectl/aws terminal (runs `admin-kubectl` / `admin-aws`, prints the output); also usable in Node |
| `popup.html` / `popup.js` | Toolbar popup UI for token actions |
| `popup-bulk.js` | Popup logic for enabling/disabling bulk per site |
| `options.html` / `options.js` | Settings page: token-sync host list and argo CLI host |
| `host/argo_sso_host.py`, `host/install.sh` | Native messaging host that writes the token files, and its installer |

### Tests

```bash
node --test test/parse.test.js
```
