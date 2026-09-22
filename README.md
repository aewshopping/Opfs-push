# Opfs-push

A small, buildless browser app that syncs a GitHub repo to this origin's OPFS,
so a separate app on the same origin — [gypsum](https://github.com/aewshopping/gypsum) —
can edit the files, and you can push the changes back.

No npm, no bundler, no dependencies. Open `index.html` from any static server.

## Use it

1. Serve the folder: `python3 -m http.server 8000`, then open
   <http://localhost:8000>. OPFS and `crypto.subtle` need a secure context, so
   `file://` will not work. GitHub Pages is fine.
2. Enter the repository, the branch and a GitHub token, then **Connect**.
3. **Pull** brings the repo into OPFS, mirrored 1:1 at the root.
4. Edit the files in the other app.
5. Come back, write a commit message and **Push**. Every push shows what it is
   about to commit before it commits anything.

### Token

Use a fine-grained personal access token limited to this one repository, with
**Contents: read and write**, and a short expiry. It is kept in localStorage and
is readable by any script on this origin — including the editor app.

## How it works

Each file's git blob sha is compared three ways: what is in OPFS, what was last
agreed with the remote (recorded in `.gitsync/index.json`), and what is on the
branch now. That is enough to tell a local edit from a remote one and to spot a
file that changed in both places. Conflicts are per file; there is no line-level
merge.

`.gitsync/` is the only thing this app owns. Everything else at the OPFS root
belongs to the repo and the editor app, `.gypsum/` included — so your notes'
history and table layouts are versioned too.

## Deleting is real

Sync is two-way, so deleting a file in the editor and pushing deletes it in the
repo. Because OPFS can be cleared by the editor app or evicted by the browser,
the app refuses to push when it cannot tell a deletion from a wipe: no sync state
means clone rather than delete, an empty workspace with tracked files is blocked,
bulk deletions need explicit confirmation, and no commit is built before you have
seen the file list.

## Layout

- `plans/app setup.md` — the design, the decisions, and why the alternatives were rejected
- `CLAUDE.md` — the constraints any change has to respect
- `tests.html` — assertions over the pure functions; open it over `http://localhost`
- `js/` — one module per job: `github`, `opfs`, `sync`, `hash`, `settings`, `log`, `config`, `main`
