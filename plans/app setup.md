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
  hosting over http/https. OPFS and `crypto.subtle` both require a secure
  context — `localhost` or https.
- **No third-party library.** The GitHub API is called directly with `fetch`.

## Decisions

| Question | Decision |
|---|---|
| Implementation | Hand-written against the GitHub REST API, no dependency |
| Repo files in OPFS | Mirrored 1:1 at the **OPFS root**, nested paths supported |
| Repo identity | Repo URL input + localStorage only (no hardcoded owner/repo) |
| Token storage | localStorage |
| Sync semantics | Full two-way sync, including deletions |
| File content | Bytes end-to-end — text and binary both work |
| Editing in this app | None — the other app is the editor; the file list is read-only |
| Conflicts | Detected per file, block the push, resolved by an explicit choice |

## Why not `browser-git-ops`

Considered and rejected after reading `browser-git-ops@0.0.8` in full. It would
have needed a mirror layer regardless, because its change detection only sees
files carrying its own `workspace/info` metadata sidecars — files written
directly to OPFS by another app are invisible to it and would never push.
Beyond that: three separate SHA-1 implementations in one bundle, of which the
git-correct one (`shaOfGitBlob`) is used at a single call site out of ~15, so it
hashes raw content rather than git blobs and therefore **must download every
file on every pull** to compare; `_changesFromTombstones()` returns `[]` with an
"unimplemented" comment; the no-adapter path fabricates commit shas; and it is
string-only, so binary files are structurally unsupported.

Forking was also rejected: the package is TypeScript built by esbuild + tsc, so
maintaining a fork reintroduces the build step this project exists without.

Writing it directly is ~400 lines, removes the mirror layer entirely, makes
binary files work, and lets pull fetch only the blobs that actually changed.

## OPFS layout

```
OPFS root
├── notes.md              ← repo files, 1:1 with the repo (what the editor app edits)
├── data/2026.json        ←
└── .gitsync/
    └── index.json        ← sync state; the only thing this app owns
```

`.gitsync/` is skipped by every scan. **The editor app must leave it alone.**

`index.json`:

```json
{
  "head": "<commit sha we last synced to>",
  "treeSha": "<tree sha of that commit>",
  "owner": "...", "repo": "...", "branch": "main",
  "files": { "notes.md": { "sha": "<git blob sha>", "mode": "100644" } }
}
```

`files[path].sha` is the **merge base**: the blob sha this app last agreed with
the remote for that path. No base copy of the content is stored — the three-way
comparison needs only shas, and the remote version of a conflicted file is
fetched on demand when asked for. This keeps OPFS usage at roughly the size of
the repo itself.

Blob shas are computed the way git does it:
`sha1("blob " + byteLength + "\0" + bytes)`, over bytes rather than a string, so
the values compare directly against the shas GitHub returns in the tree API.

## Sync model

For each path in `union(local, index.files, remote)`, with `L` = local blob sha,
`B` = base sha from `index.json`, `R` = remote blob sha (any of them `null` for
"absent"):

| Condition | Meaning | Action |
|---|---|---|
| `L === R` | already in agreement | set base = `R` |
| `L === B` | changed on the remote only | apply remote: write bytes, or delete if `R` is null |
| `R === B` | changed locally only | leave alone; it goes out on the next push |
| otherwise | changed on both sides | **conflict** — leave local untouched, record it |

Deletions fall out of this naturally, as the cases where `L` or `R` is `null`.

**Conflict resolution** is a per-file choice, offered in the UI:

- *Keep mine* — set base = `R`. The local version then reads as a local-only
  change and overwrites the remote on the next push.
- *Take theirs* — fetch the remote blob, write it locally, set base = `R`.

Either way the file returns to a consistent state. Conflicts are file-level, not
line-level; there is no text merge.

## Behaviour

**Connect** — read repo URL + token from the inputs (prefilled from
localStorage), persist both, parse `owner`/`repo` from the URL (accepts
`https://github.com/owner/repo[.git]` or bare `owner/repo`), and verify access
with a single `GET /repos/{owner}/{repo}` so a bad token fails immediately and
clearly.

**Pull** — `pull()`
1. Scan OPFS root → `Map<path, {bytes, sha}>`, skipping `.gitsync`.
2. `GET /repos/{o}/{r}/git/ref/heads/{branch}` → commit sha;
   `GET .../git/trees/{sha}?recursive=1` → remote entries.
   If the response has `truncated: true`, abort with a clear message — the repo
   is too large for a single tree read.
   Entries that are not `type: "blob"` (submodules, symlinks) are skipped and logged.
3. Classify every path per the table above.
4. Fetch blobs **only** for the paths that need applying, through a small
   concurrency pool (6 at a time), and write them to OPFS. Delete locally what
   was deleted remotely, then prune emptied directories.
5. Write `index.json`: `head`/`treeSha` from the remote, `files` updated for
   every path except unresolved conflicts, which keep their old base sha.
6. Re-render the file list and the conflict panel.

**Push** — `push(message)`
1. Refuse if conflicts are outstanding, and say which files.
2. `pull()` first, always — avoids committing against a stale head.
3. If that pull produced conflicts, abort and surface them.
4. Diff local against `index.files`: `created` (`L`, no `B`), `updated`
   (`L !== B`), `deleted` (`B`, no `L`). If all three are empty, log
   "nothing to push" and stop.
5. `POST .../git/blobs` for each created/updated file (base64, pooled) → blob shas.
6. `POST .../git/trees` with `base_tree: index.treeSha`, one entry per change;
   deletions are sent as `{ path, mode, type: "blob", sha: null }`.
7. `POST .../git/commits` with `parents: [index.head]`.
8. `PATCH .../git/refs/heads/{branch}`. A 422 here means non-fast-forward —
   report it and tell the user to pull.
9. Update `index.json` from what was just pushed — the new commit sha, the new
   tree sha, and the blob shas already known from step 5. No refetch needed.

Every network and OPFS call is wrapped; failures print to the log area instead
of throwing unhandled. Buttons disable while an operation is in flight.

## Files

```
index.html         page shell, loads js/main.js as <script type="module">
style.css          plain CSS, no framework
js/config.js       API base URL, default branch, STORE_DIR = '.gitsync'
js/log.js          append lines to the log area (info / warn / error)
js/settings.js     localStorage for repo URL + token; URL → {owner, repo}
js/hash.js         gitBlobSha(bytes), chunked base64 encode/decode
js/github.js       getRepo, getRef, getTree, getBlob, createBlob, createTree,
                   createCommit, updateRef, plus the concurrency pool
js/opfs.js         walkRoot, read, write, remove, pruneDirs, readIndex, writeIndex
js/sync.js         scanLocal, classify, pull, push, resolveConflict
js/main.js         DOM wiring and rendering
```

Base64 encoding is chunked — `btoa(String.fromCharCode(...bytes))` overflows the
call stack on files of any size.

## UI (single page)

- Repo URL input, token input (`type="password"`), **Connect** button
- **Pull** button
- File list: vertically scrollable, one line per file, path + status
  (`new` / `modified` / `deleted` / `conflict` / unchanged). Read-only.
- Commit message input + **Push** button
- Conflict panel, hidden when empty: per file, *view remote*, *keep mine*,
  *take theirs*
- `<pre>` log area for status and errors

## Risks and accepted trade-offs

- The token is readable by any script on the GitHub Pages origin. Mitigation is
  procedural: a fine-grained PAT limited to this one repo, `contents:
  read/write`, short expiry.
- Full two-way sync deletes. Deleting a file in the editor app and pushing
  deletes it in the repo; a file deleted upstream disappears locally on pull.
  Recovery is via git history only.
- First pull of a repo with N files costs N+2 API requests. Authenticated limit
  is 5000/hour, so this is comfortable for hundreds of files; later pulls only
  fetch what changed. A large initial clone could later use the tarball
  endpoint, but that needs a tar/gzip decoder and is out of scope.
- Trees above GitHub's single-response limit are rejected rather than paged.
- Conflicts are file-level. No line-level merge, ever.
- Two tabs of this app open at once is unsupported — OPFS writes would interleave.
- Empty repo (no commits yet) is an edge case to handle explicitly on first pull.

## Verification

Serve locally (`python3 -m http.server`, then `http://localhost:8000`) and,
against a scratch repo:

1. Connect with a bad token → clear failure, no partial state.
2. Connect, Pull → repo files appear at the OPFS root, nested paths intact.
3. Edit a file via the other app (or devtools), Push → commit lands on `main`.
4. Change a file on GitHub, Pull → only that blob is fetched; change appears locally.
5. Delete a file locally, Push → deleted in the repo.
6. Add a binary file (a small PNG), Push, delete locally, Pull → byte-identical.
7. Change the same file on both sides, Pull → conflict listed, push blocked;
   *keep mine* then Push overwrites remote; *take theirs* restores the remote version.
8. Push with no changes → "nothing to push", no commit.
