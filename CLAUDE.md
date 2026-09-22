# CLAUDE.md

Guidance for working in this repo. The full design lives in `plans/app setup.md`.

## What this is

A buildless browser app, served from GitHub Pages, that syncs a GitHub repo to
OPFS. A separate app on the same origin edits those OPFS files; this app pulls
and pushes them.

## Design principles

These are constraints, not preferences. If a change requires breaking one, stop
and ask rather than working around it.

### 1. No build step. Ever.

Plain HTML, CSS and ES modules, opened directly by the browser. No npm, no
`package.json`, no `node_modules`, no bundler, no transpiler, no minifier. The
dev server is `python3 -m http.server`. Deployment is committing files.

A change that needs compiling is the wrong change.

### 2. No runtime dependencies

No CDN imports, no vendored libraries. Everything the app does — the GitHub API,
git blob hashing, OPFS access, base64 — is a few hundred lines of code we own
and can read in one sitting.

`browser-git-ops` was evaluated and rejected; `plans/app setup.md` records why in
detail. Do not reintroduce it or reach for an equivalent. If something looks like
it needs a library, it probably needs about 40 lines instead.

### 3. Vanilla everything

No framework, no CSS framework, no state-management layer. Direct DOM calls and
plain CSS. The UI is a handful of controls and a list; it does not need
abstraction.

### 4. The OPFS root is shared territory

Repo files mirror the repo 1:1 at the OPFS root, because that is where the other
app expects them. `.gitsync/` is the only thing this app owns.

- Never write app state anywhere but `.gitsync/`.
- Never assume a file at the root came from us — the other app writes there too.
- Skip `.gitsync/` when scanning, along with everything else in
  `IGNORE_PATTERNS`.
- The companion app is [gypsum](https://github.com/aewshopping/gypsum). It owns
  `.gypsum/` at the root. That directory **is synced** — its history and layout
  files are worth versioning — but this app only ever reads it. Do not write
  into `.gypsum/`, `mtime.json` included.
- Gypsum's transient save artifacts (`*-save`, `*-autosave`, `*-temp`
  `.gypsum` files) are ignored by pattern; they exist only between a write and
  its verification, and committing them churns history for nothing.
- Gypsum's tar import/export is a **separate workflow**, not one that runs
  alongside this app. In a git-synced setup, git is the backup mechanism — which
  is why `.gypsum/` is worth versioning.
- The workspace can vanish at any time, and not only because an app cleared it:
  OPFS here is evictable under disk pressure. The app must survive that; see the
  safeguards below. Do not assume anything in OPFS is still there because it was
  there last time.

### 5. Bytes, not strings

File content is `Uint8Array` end to end. Base64 conversion happens only at the
GitHub API boundary, and it is chunked — `btoa(String.fromCharCode(...bytes))`
overflows the call stack on real files. Text and binary take the same path; there
is no "text mode".

### 6. Hash exactly like git

Blob shas are `sha1("blob " + byteLength + "\0" + bytes)`, computed over bytes.
Never a plain SHA-1 of content. These values are compared directly against the
shas GitHub returns in the tree API, so any deviation silently breaks change
detection — everything looks modified, or nothing does.

### 7. Destructive actions are previewed, confirmed, and guarded

Deleting files is the only way this app can lose someone's work. The guards in
`plans/app setup.md` — no merge base means no push, an empty workspace blocks
the push, bulk deletions need explicit confirmation, every push is previewed —
exist because a partial OPFS wipe is indistinguishable from a deliberate
delete-everything.

Do not weaken, bypass or "streamline" these. Tune the thresholds in
`js/config.js` if they are noisy; do not remove the checks.

### 8. Failures are visible, never thrown away

Every network and OPFS call is wrapped. Failures print to the on-page log area
with enough context to act on. No unhandled rejections, no `catch {}` that
swallows, no error state that leaves the UI looking like it succeeded. Buttons
disable while an operation is in flight.

### 9. Small modules, one job each

Each file in `js/` does one thing and says so in a comment at the top. If a
module starts needing a paragraph to explain, split it.

### 10. Secrets stay out of the repo

The GitHub token lives in localStorage, entered through the UI. Never hardcode
it, never commit it, never log it, never put it in a URL. Any config file in
this repo is public — it is served from GitHub Pages.

## Testing

There is no test runner, because there is no npm.

`tests.html` holds assertions over the pure functions — hashing, base64, the
ignore patterns, `classify`, `statusList`. Open it over `http://localhost` and
every check should pass. It needs no repo, token or network, so run it on every
change, and add a case whenever you fix a bug in that layer.

The git blob shas in it came from real `git hash-object` output. If one ever
disagrees, the hashing is wrong and change detection is broken — fix the code,
never the expected value.

Everything else is the manual checklist at the end of `plans/app setup.md`, run
against a scratch repo. Do not add a test framework.

## Environment notes

- OPFS and `crypto.subtle` both require a secure context — `localhost` or https.
  Opening `index.html` as a `file://` URL will not work.
- Two tabs of this app open at once is unsupported; OPFS writes would interleave.
- Concurrent `getDirectoryHandle()` and `values()` on the same OPFS directory
  deadlock in Chromium. Collect entry names first, then act on them — the
  pattern gypsum's `clearOPFS()` uses.
- Authenticated GitHub API limit is 5000 requests/hour. A first pull costs one
  request per file, so be deliberate about anything that multiplies request count.
