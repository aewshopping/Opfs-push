# App setup — GitHub ⇄ OPFS sync app

Status: **implemented.** The automated checks below pass; the items marked
*needs a real repo* have not been run against live GitHub yet.

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
| Wipe protection | Push is previewed every time and blocked on suspicious deletion patterns |
| First pull into a non-empty workspace | Prompt once: *Replace* (recommended) or *Adopt* |
| Scope of the mirror | The whole repo, `.gypsum/` included — no extension allowlist |
| Transient Gypsum files | Ignored by pattern, so half-written saves never reach the repo |
| `.gypsum/mtime.json` | Synced, but never written by this app |

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

## Companion app: Gypsum

The editor on this origin is [gypsum](https://github.com/aewshopping/gypsum) — a
browser notes app over `.txt`/`.md` files. It can run against a picked local
folder or against OPFS; only the OPFS mode concerns this app. Verified against
its source, the facts that constrain this design:

- **It owns `.gypsum/` at the OPFS root**, holding `history.gypsum`,
  `table_layouts.gypsum`, `mtime.json`, and transient `*-save.gypsum` /
  `*-autosave.gypsum` / `*-temp.gypsum` written and removed around each save,
  plus durable `*-trash.gypsum` copies of deleted notes.
- **`.gypsum/` is synced deliberately**, so edit history and table layouts are
  versioned alongside the notes. This app reads it like any other directory and
  **never writes into it** — `mtime.json` in particular is Gypsum's to maintain.
- **Only `.txt` and `.md` are visible to Gypsum.** Its loader and its tar backup
  both collect those two extensions plus everything under `.gypsum/`, and both
  skip dot-directories otherwise.
- **Its tar import/export is a separate workflow from this app**, not a
  complementary one: both are routes for getting files into OPFS, and a given
  setup uses one or the other. In a git-synced setup **git is the backup
  mechanism**, which is why `.gypsum/` is synced — the edit history and table
  layouts have no other route off the machine.
- **OPFS here is evictable.** Gypsum never calls `navigator.storage.persist()`,
  and notes in its own source that the browser may clear the storage under disk
  pressure. Nothing in either app has to misbehave for the workspace to vanish.
  This, rather than any app action, is the primary justification for guards 1
  and 2.
- **`clearOPFS()` removes every root entry recursively, dot-directories
  included**, so a tar import that hits its overwrite path deletes `.gitsync/`
  too. That is the safe outcome: guard 1 sees no merge base and re-clones.
- **`hasOPFSContent()` ignores dot-directories and counts only `.txt`/`.md`
  files**, so an OPFS holding just `.gitsync/` and non-note files imports with
  *no* overwrite warning and *no* `clearOPFS()`, leaving `index.json` intact
  while the file set changes beneath it. Not an expected workflow, but it is the
  shape guard 2 catches, and eviction can produce the same shape unaided.
- Gypsum notes that concurrent `getDirectoryHandle()` and `values()` on the same
  OPFS directory **deadlock in Chromium**. Collect entry names first, then act.

### Ignored patterns

`config.js` carries an `IGNORE_PATTERNS` list, applied in both directions:

```
.gitsync/**              this app's own state
**/*-save.gypsum         mid-save artifacts, removed once the write verifies
**/*-autosave.gypsum
**/*-temp.gypsum
```

Without these, an autosave landing between a scan and a push would commit a
half-written recovery file and then commit its deletion moments later, churning
the history for no gain. `history.gypsum`, `table_layouts.gypsum`, `mtime.json`
and `*-trash.gypsum` are durable and do sync.

### Requesting persistent storage

On connect, the app calls `navigator.storage.persist()` once. The two apps share
one origin and therefore one storage bucket, so a granted request protects
Gypsum's notes as much as this app's sync state. Browsers differ on how they
answer — Chromium decides silently on engagement heuristics, Firefox may prompt —
so the result is logged and never blocks anything. A refusal changes nothing
about how the app behaves; the guards already assume the workspace can vanish.

### If the two import paths do meet

Not an expected combination, but worth knowing the failure is benign. Gypsum's
tar backup carries only `.txt`/`.md` and `.gypsum/`, so if the repo holds
anything else — a `LICENSE`, a `.github/` folder, images — a backup and
re-import removes it from OPFS, and this app reads that as a deletion and offers
to push it. The push preview shows exactly that, and declining costs nothing: a
pull restores the files, because the deletion was never committed.

Because `history.gypsum` is mutated by every edit, syncing from two machines will
conflict on it routinely. Single-machine use has no such problem.

## First pull into a non-empty workspace

On a first pull there is no `index.json`, so the base sha is `null` for every
path. Run that through the table above and pre-existing OPFS files — whatever the
editor app left there — classify badly:

- A local file **not** in the repo hits `R === B` (both null) and reads as a
  local-only change, so the first push would commit the editor's leftovers into
  the repo.
- A local file that collides with a repo path but differs matches nothing and
  becomes a conflict, one per file.

Neither is wanted. The app therefore treats "no `index.json` and a non-empty
workspace" as a distinct case and asks once, naming the file counts:

- **Replace** (recommended) — make the OPFS root exactly match the repo. Files
  not in the repo are deleted, files that differ are overwritten, and files that
  are already byte-identical are left untouched (no needless download or write).
  The end state is a clean mirror and a correct `index.json`.
- **Adopt** — keep what is there. Repo files are written, local files not in the
  repo become pending additions, and differing files become conflicts. For the
  case where the existing OPFS files are work you actually want in the repo.

An empty workspace skips the prompt entirely and just clones, which is the
common case.

This question arises exactly once per setup. Afterwards `index.json` exists and
the ordinary three-way model covers everything.

The same *Replace* operation is also exposed permanently as **Reset workspace
from repo**, for discarding all local changes and returning to a known state.
It is destructive in the local direction, so it previews what it would delete
and overwrite and requires confirmation. Note that this is a different guard
from the push safeguards below: those protect the repo from bad local state,
this protects local state from a careless reset.

## Safeguards against accidental mass deletion

The editor app on this origin can clear all of OPFS. That interacts with the
sync model in a way that is worth stating plainly, because it is the opposite of
what intuition suggests:

- **A complete wipe is safe.** If `.gitsync/index.json` goes too, the next pull
  sees no local files and no merge base, so every remote path classifies as new
  and the repo re-clones cleanly.
- **A partial wipe is the dangerous one.** If `index.json` survives while the
  files do not — a delete-all that skips dot-directories, or one that fails
  partway — then every tracked path reads as `B` present, `L` absent, which is
  precisely the signature of a deliberate local deletion. An unguarded push would
  commit the deletion of the entire repo.

Four guards, in order of severity:

**1. No merge base, no push.** If `index.json` is missing, unparseable, or has no
`head`, push is disabled outright and only pull is offered. Without a base sha
per file the app cannot distinguish "deleted" from "never seen", so it must not
guess. A missing index always means clone, never delete.

**2. Empty-workspace block.** If the local scan finds zero files while the index
tracks one or more, the push is refused with a message naming the tracked count
and pointing at Pull as the fix. This is the wipe signature, and it is never
what a user meant by "push my changes". Overriding it is possible but
deliberate — a separate confirmation that names the count of files to be
deleted, not a single click.

**3. Bulk-deletion confirmation.** Any push whose deletions exceed either
threshold in `config.js` — `MAX_SILENT_DELETES` (5 files) or
`MAX_SILENT_DELETE_RATIO` (20% of tracked files) — lists every affected path and
requires an explicit confirmation before the commit is built.

**4. Every push is previewed.** Push is always two steps: a summary of what is
about to be committed, broken down as new / modified / deleted with deletions
called out, and then a confirm. There is no path that commits without the user
having seen the file list first.

The pull side warns too: if a pull finds the workspace empty while the index
tracks files, it says so in the log before re-cloning, so the wipe is visible
rather than silently repaired.

None of this is a substitute for the underlying safety net — every state the app
has ever pushed is recoverable from git history — but a mass-deletion commit is
tedious to unpick, and these guards mean it cannot happen by accident.

## Behaviour

**Connect** — request persistent storage (once, non-blocking), then read repo
URL + token from the inputs (prefilled from
localStorage), persist both, parse `owner`/`repo` from the URL (accepts
`https://github.com/owner/repo[.git]` or bare `owner/repo`), and verify access
with a single `GET /repos/{owner}/{repo}` so a bad token fails immediately and
clearly.

**Pull** — `pull()`
1. Scan OPFS root → `Map<path, {bytes, sha}>`, applying `IGNORE_PATTERNS`. If there is
   no `index.json` and the scan is non-empty, stop and ask Replace or Adopt
   (see above) before going further.
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
0. Refuse if there is no usable merge base (guard 1), or if the workspace is
   empty while files are tracked (guard 2).
1. Refuse if conflicts are outstanding, and say which files.
2. `pull()` first, always — avoids committing against a stale head.
3. If that pull produced conflicts, abort and surface them.
4. Diff local against `index.files`: `created` (`L`, no `B`), `updated`
   (`L !== B`), `deleted` (`B`, no `L`). If all three are empty, log
   "nothing to push" and stop.
5. Show the preview (guard 4) — new / modified / deleted, deletions listed in
   full — and wait for confirmation; if the deletion count trips guard 3, that
   confirmation is the explicit one. Nothing below this line runs before the
   user has confirmed.
6. `POST .../git/blobs` for each created/updated file (base64, pooled) → blob shas.
7. `POST .../git/trees` with `base_tree: index.treeSha`, one entry per change;
   deletions are sent as `{ path, mode, type: "blob", sha: null }`.
8. `POST .../git/commits` with `parents: [index.head]`.
9. `PATCH .../git/refs/heads/{branch}`. A 422 here means non-fast-forward —
   report it and tell the user to pull.
10. Update `index.json` from what was just pushed — the new commit sha, the new
   tree sha, and the blob shas already known from step 5. No refetch needed.

Every network and OPFS call is wrapped; failures print to the log area instead
of throwing unhandled. Buttons disable while an operation is in flight.

## Files

```
CLAUDE.md          design principles and working constraints for this repo
index.html         page shell, loads js/main.js as <script type="module">
style.css          plain CSS, no framework
js/config.js       API base URL, default branch, STORE_DIR = '.gitsync',
                   IGNORE_PATTERNS, MAX_SILENT_DELETES, MAX_SILENT_DELETE_RATIO
js/log.js          append lines to the log area (info / warn / error)
js/settings.js     localStorage for repo URL + token; URL → {owner, repo}
js/hash.js         gitBlobSha(bytes), chunked base64 encode/decode
js/github.js       getRepo, getRef, getTree, getBlob, createBlob, createTree,
                   createCommit, updateRef, plus the concurrency pool
js/opfs.js         walkRoot, read, write, remove, pruneDirs, readIndex, writeIndex
js/sync.js         scanLocal, classify, pull, push, resolveConflict
js/main.js         DOM wiring and rendering
tests.html         assertions over the pure functions, run in the browser
```

`CLAUDE.md` holds the durable design principles — no build step, no runtime
dependencies, bytes not strings, git-compatible hashing, the `.gitsync/`
ownership boundary, and the rule that the deletion guards may be retuned but not
removed. It references this plan rather than duplicating it, so the two do not
drift.

Base64 encoding is chunked — `btoa(String.fromCharCode(...bytes))` overflows the
call stack on files of any size.

## UI (single page)

- Repo URL input, token input (`type="password"`), **Connect** button
- **Pull** button, and a **Reset workspace from repo** action (previewed and
  confirmed) for discarding all local changes
- File list: vertically scrollable, one line per file, path + status
  (`new` / `modified` / `deleted` / `conflict` / unchanged). Read-only.
- Commit message input + **Push** button, which opens a preview (new / modified
  / deleted, deletions listed) that must be confirmed before anything is committed
- Tracked-file count shown next to the file list, so a wipe is visible at a glance
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

`tests.html` covers the pure functions — git blob hashing (against values from
`git hash-object`), base64 round trips, the ignore patterns, the classification
table and the status rows. Open it alongside the app; it needs no repo, token or
network.

The checks below marked **[automated]** have also been run headless against real
OPFS with a stateful stub of the GitHub API, which confirmed the pull/push round
trip, the tree entry shapes and the guards. That stub is not GitHub, so none of
it proves live API compatibility. Work the rest by hand: serve locally
(`python3 -m http.server`, then `http://localhost:8000`) against a scratch repo.

1. *Needs a real repo.* Connect with a bad token → clear failure, no partial state.
2. **[automated]** Connect, Pull → repo files appear at the OPFS root, nested paths intact.
3. Edit a file via the other app (or devtools), Push → commit lands on `main`.
4. **[automated]** Change a file on GitHub, Pull → only that blob is fetched; a repeat pull fetches none.
5. **[automated]** Delete a file locally, Push → sent as a null sha, deleted in the repo.
6. **[automated]** for the OPFS byte round trip; *needs a real repo* for the GitHub leg.
7. **[automated]** Change the same file on both sides, Pull → conflict listed,
   local file untouched, push blocked; *take theirs* restores the remote version
   and leaves nothing to push. *Keep mine* still needs a real repo.
8. **[automated]** Push with no changes → "nothing to push", no commit. Declining
   the preview also commits nothing and leaves the branch head where it was.
9. Delete `.gitsync/index.json` only, Pull → clean re-clone, push stays disabled
   until it completes.
10. **[automated]** Delete every file but leave `index.json`, Push → refused by
    guard 2, naming the tracked count and the paths; the deliberate override then
    goes through. Pull restores everything.
11. Delete 6 of 10 files, Push → bulk confirmation listing all six; declining
    commits nothing.
12. With unrelated files already in OPFS and no `index.json`, Pull → prompted;
    *Replace* leaves the root exactly matching the repo and those files gone;
    identical files are not re-downloaded.
13. Same setup, *Adopt* → repo files written, the unrelated files listed as
    pending additions, colliding files listed as conflicts.
14. Edit two files, Reset workspace from repo → preview names both, confirming
    restores them and clears the pending changes.
15. Trigger a Gypsum autosave mid-edit, Push → no `*-autosave.gypsum` or
    `*-temp.gypsum` appears in the preview or the commit.
16. Edit a note in Gypsum so `history.gypsum` changes, Push → the history file
    is committed alongside the note.
17. Robustness check, not an expected flow: run a Gypsum tar backup and
    re-import (its overwrite path), then Pull → `.gitsync/` was wiped with
    everything else, so it re-clones cleanly rather than proposing deletions.
18. Connect → the persistent-storage result is logged, and a refusal leaves
    every other operation working normally.
