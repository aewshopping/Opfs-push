# App setup — GitHub ⇄ OPFS sync app

Status: **agreed plan, not yet implemented.**

## Goal

A minimal, buildless browser app, served from GitHub Pages, that pulls a GitHub
repo into OPFS and pushes OPFS changes back to GitHub. A *separate* app on the
same origin (also GitHub Pages) edits those OPFS files directly; the user
returns to this app to push.

## Constraints

- No build step. Plain HTML/JS/CSS, ES modules loaded directly by the browser.
- No npm, no `package.json`, no `node_modules`, no dev server beyond static
  hosting over http/https (OPFS needs a secure context — `localhost` or https).
- Library: `browser-git-ops`, loaded from a CDN as an ES module.

## Decisions

| Question | Decision |
|---|---|
| How the editor app touches OPFS | Raw OPFS at the **root**, text files, subfolders allowed |
| Library delivery | Pinned jsDelivr URL |
| Repo identity | Repo URL input + localStorage only (no hardcoded owner/repo) |
| Token storage | localStorage; the library also persisting it into its OPFS `index` file is **accepted** |
| Mirror semantics | Full two-way mirror, including deletions |
| File content | UTF-8 text only; nested paths supported |
| Textarea editor | Dropped — the other app is the editor |
| Conflict UI | Included: view conflicting remote version, mark resolved |

## Library facts (verified against npm `browser-git-ops@0.0.8`)

- CDN URL to hardcode:
  `https://cdn.jsdelivr.net/npm/browser-git-ops@0.0.8/dist/index.mjs`
  — verified 200, ~272 KB, an esbuild `--format=esm --platform=browser` bundle
  with no external imports, so it runs in the browser as-is.
  (`https://esm.sh/browser-git-ops` also resolves but rewrites the module to
  `import "/node/buffer.mjs"`; avoided.)
- Exports: `VirtualFS` (also default), `OpfsStorage`, `IndexedDatabaseStorage`,
  `InMemoryStorage`, `GitHubAdapter`, `GitLabAdapter`.
- `new OpfsStorage(namespace, root?)` → OPFS directory `namespace/root`.
- Internal OPFS layout under that directory:
  - `workspace/base/<path>` — working copy
  - `workspace/info/<path>` — per-file JSON metadata (`state`, `baseSha`, `workspaceSha`)
  - `.git/<branch>/base|info|conflict|conflictBlob/<path>` — pulled base snapshot
  - `index` — JSON with `head`, `lastCommitKey`, `adapter` (**token included**)
- **There is no `vfs.getConflicts()`** (the original draft assumed one).
  Conflicts are returned by `pull()` as `{ conflicts: [...] }`; individual
  conflicts are read with `readConflict(path)` and cleared with
  `resolveConflict(path)`.
- `readFile`/`writeFile` are string-only — content is hashed as text
  (`TextEncoder` → SHA-1). Binary content is not supported.
- **`getChangeSet()` only sees files that have a `workspace/info` sidecar.** A
  file written straight into `workspace/base` by another app produces no change
  and would never be pushed. This is why the mirror below exists: everything
  reaching the library must go through `vfs.writeFile()` / `vfs.unlink()`.

## Architecture: the OPFS mirror

The editor app and the library do not share a storage format, so this app owns
a mirror between them.

```
OPFS root
├── notes.md              ← editor app's files (flat + subfolders)
├── data/2026.json        ←
└── .gitsync/             ← this app's private store, ignored by the mirror
    └── repo/
        ├── workspace/...
        ├── .git/...
        └── index
```

Store handle: `new OpfsStorage('.gitsync', 'repo')`. The mirror walks the OPFS
root recursively and **skips the `.gitsync` directory**. The editor app must
likewise leave `.gitsync` alone.

Two directions:

- `importRawToVfs()` — raw area is the source of truth.
  Walk raw → for each path, `vfs.readFile(p)`; if different, `vfs.writeFile(p, content)`.
  For each VFS path absent from raw, `vfs.unlink(p)`.
- `exportVfsToRaw()` — VFS is the source of truth.
  For each VFS path, write the file into the raw area (creating directories).
  Delete raw files absent from the VFS and prune the emptied directories.

Non-UTF-8 files are skipped with a warning in the log (cheap guard: decoded text
containing a NUL or U+FFFD), so a stray binary corrupts nothing silently.

## Behaviour

**Connect**
1. Read repo URL + token from the inputs (prefilled from localStorage), persist both.
2. Parse `owner`/`repo` from the URL (accepts `https://github.com/owner/repo[.git]`
   or bare `owner/repo`).
3. `const backend = new OpfsStorage('.gitsync', 'repo')`
   `const vfs = new VirtualFS({ backend }); await vfs.init();`
4. `await vfs.setAdapter({ type: 'github', branch: 'main', token, opts: { owner, repo } })`

**Pull** — `syncPull()`
1. `importRawToVfs()` **first**, so edits made in the editor app since the last
   sync are registered as workspace changes rather than silently overwritten.
2. `const { conflicts } = await vfs.pull()`
3. `exportVfsToRaw()` — the raw area now reflects the merged state.
4. Re-render the file list; if `conflicts` is non-empty, log a warning and show
   the conflict panel.

**Push** — `syncPush(message)`
1. `importRawToVfs()` — raw area is the truth.
2. `await vfs.pull()` — always, no exceptions; avoids pushing against a stale
   head if the repo moved. If it reports conflicts, **abort the push**, export
   the merged state back to raw, and surface the conflicts.
3. `const changes = await vfs.getChangeSet()`; if empty, log "nothing to push"
   and return `null`.
4. `const index = await vfs.getIndex()`
5. `await vfs.push({ parentSha: index.head, message, changes })`
6. `exportVfsToRaw()`, re-render.

Every `vfs` call is wrapped in try/catch; failures are printed to the log area
instead of throwing unhandled. Buttons disable while an operation is in flight.

## Files

```
index.html            page shell, loads js/main.js as <script type="module">
style.css             plain CSS, no framework
js/config.js          CDN URL, BRANCH = 'main', store namespace/root constants
js/log.js             append lines to the log area (info / warn / error)
js/settings.js        localStorage get/set for repo URL + token; URL → {owner, repo}
js/vfs.js             build OpfsStorage + VirtualFS, connect()
js/opfs-mirror.js     scanRaw / importRawToVfs / exportVfsToRaw
js/sync.js            syncPull / syncPush / conflict helpers
js/main.js            DOM wiring and rendering
```

No `config.js` constants for owner/repo — repo identity lives only in the input
and localStorage.

## UI (single page)

- Repo URL input, token input (`type="password"`), **Connect** button
- **Pull** button
- File list: vertically scrollable, one line per file, path + status
  (`added` / `modified` / `deleted` / unchanged) derived from `getChangeSet()`.
  Read-only — no editing here.
- Commit message input + **Push** button
- Conflict panel (hidden when empty): per conflicting path, a "view remote"
  button (`readConflict`) and a "mark resolved" button (`resolveConflict`)
- `<pre>` log area for status and errors

## Risks and accepted trade-offs

- `browser-git-ops` is at `0.0.8` — pre-1.0, small, and the API has rough edges
  (the missing `getConflicts`, the info-sidecar coupling). The version is pinned
  so it cannot change underneath the app.
- The token is readable by any script on the GitHub Pages origin, from both
  localStorage and the OPFS `index` file. Mitigation is procedural: use a
  fine-grained PAT limited to this one repo with `contents: read/write` and a
  short expiry.
- Full two-way mirroring deletes files. Deleting a file in the editor app and
  pushing will delete it in the repo; a file deleted upstream disappears locally
  on the next pull.
- `pull()` fetches a whole-repo snapshot. Fine for a small repo; slow and
  rate-limit-prone for a large one.
- Binary files are out of scope and will be skipped, not converted.
- Two tabs of this app open at once is unsupported — OPFS writes would interleave.

## Verification

Serve locally (`python3 -m http.server`, then `http://localhost:8000`) and,
against a scratch repo:

1. Connect, Pull → repo files appear at the OPFS root.
2. Edit a file with the other app (or devtools), Push → commit lands on `main`.
3. Change a file on GitHub, Pull → change appears in the raw area.
4. Delete a file locally, Push → file is deleted in the repo.
5. Change the same file on both sides, Pull → conflict is logged and listed.
6. Push with no changes → "nothing to push", no commit.
