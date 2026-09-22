// DOM wiring: reads the controls, calls into sync, renders what comes back.
// No logic lives here beyond deciding what to show and when to enable a button.

import { parseRepoUrl, loadSettings, saveSettings } from './settings.js';
import { GitHub } from './github.js';
import { initLog, log, describeError } from './log.js';
import { requestPersistence, readIndex } from './opfs.js';
import { pull, push, replaceFromRemote, resolveConflict, scanLocal, statusList } from './sync.js';

const el = id => document.getElementById(id);

const dom = {
    repoUrl: el('repo-url'), branch: el('branch'), token: el('token'),
    connect: el('btn-connect'), connection: el('connection'),
    pull: el('btn-pull'), reset: el('btn-reset'), push: el('btn-push'),
    message: el('commit-message'),
    fileList: el('file-list'), trackedCount: el('tracked-count'),
    conflictPanel: el('conflict-panel'), conflictList: el('conflict-list'),
    confirmDialog: el('confirm-dialog'), confirmTitle: el('confirm-title'),
    confirmBody: el('confirm-body'), confirmOk: el('confirm-ok'),
    confirmExplicit: el('confirm-explicit'), confirmTyped: el('confirm-typed'),
    firstPullDialog: el('firstpull-dialog'), firstPullBody: el('firstpull-body'),
    viewDialog: el('view-dialog'), viewTitle: el('view-title'), viewBody: el('view-body'),
};

let api = null;
let state = { local: new Map(), index: null, conflicts: [] };
let busy = false;

// ---------------------------------------------------------------- dialogs

/**
 * @param {HTMLDialogElement} dialog
 * @returns {Promise<string>} the value of the button that closed it
 */
function openDialog(dialog) {
    return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
        dialog.showModal();
    });
}

/**
 * @param {{title: string, groups: Array<{title: string, items: string[], destructive?: boolean}>, note?: string, requireTyped?: boolean, confirmLabel?: string}} options
 * @returns {Promise<boolean>}
 */
async function askConfirm({ title, groups, note, requireTyped = false, confirmLabel = 'Continue' }) {
    dom.confirmTitle.textContent = title;
    dom.confirmBody.replaceChildren();

    if (note) {
        const paragraph = document.createElement('p');
        paragraph.textContent = note;
        dom.confirmBody.append(paragraph);
    }
    for (const group of groups.filter(entry => entry.items.length > 0)) {
        const wrapper = document.createElement('div');
        wrapper.className = 'group';
        const heading = document.createElement('div');
        heading.className = `group-title${group.destructive ? ' destructive' : ''}`;
        heading.textContent = `${group.title} (${group.items.length})`;
        const list = document.createElement('ul');
        for (const item of group.items) {
            const row = document.createElement('li');
            row.textContent = item;
            list.append(row);
        }
        wrapper.append(heading, list);
        dom.confirmBody.append(wrapper);
    }

    dom.confirmOk.textContent = confirmLabel;
    dom.confirmExplicit.hidden = !requireTyped;
    dom.confirmTyped.value = '';
    dom.confirmOk.disabled = requireTyped;
    if (requireTyped) {
        const check = () => { dom.confirmOk.disabled = dom.confirmTyped.value.trim().toLowerCase() !== 'delete'; };
        dom.confirmTyped.addEventListener('input', check);
        dom.confirmDialog.addEventListener('close', () => dom.confirmTyped.removeEventListener('input', check), { once: true });
    }

    const result = await openDialog(dom.confirmDialog);
    dom.confirmOk.disabled = false;
    return result === 'ok';
}

/**
 * @param {number} count
 * @returns {Promise<'replace'|'adopt'|'cancel'>}
 */
async function askFirstPull(count) {
    dom.firstPullBody.textContent =
        `OPFS already holds ${count} file(s) and this app has no record of them. `
        + 'Replace makes the workspace match the repo exactly, deleting anything not in it. '
        + 'Adopt keeps them and offers them as additions on the next push.';
    const choice = await openDialog(dom.firstPullDialog);
    return choice === 'replace' || choice === 'adopt' ? choice : 'cancel';
}

// ---------------------------------------------------------------- rendering

/**
 * @returns {void}
 */
function render() {
    const tracked = Object.keys(state.index?.files ?? {}).length;
    dom.trackedCount.textContent = state.index
        ? `${tracked} tracked · ${state.local.size} in workspace`
        : 'no sync state';

    const rows = statusList(state.local, state.index, state.conflicts);
    dom.fileList.replaceChildren();
    if (rows.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = state.index ? 'Workspace is empty.' : 'Connect and pull to see files.';
        dom.fileList.append(empty);
    }
    for (const row of rows) {
        const item = document.createElement('li');
        const tag = document.createElement('span');
        tag.className = `tag tag-${row.status}`;
        tag.textContent = row.status === 'unchanged' ? '' : row.status;
        const path = document.createElement('span');
        path.className = 'path';
        path.textContent = row.path;
        item.append(tag, path);
        dom.fileList.append(item);
    }

    renderConflicts();
    updateButtons();
}

/**
 * @returns {void}
 */
function renderConflicts() {
    dom.conflictPanel.hidden = state.conflicts.length === 0;
    dom.conflictList.replaceChildren();
    for (const conflict of state.conflicts) {
        const item = document.createElement('li');
        const path = document.createElement('span');
        path.className = 'path';
        path.textContent = conflict.remote ? conflict.path : `${conflict.path} (deleted on the remote)`;
        item.append(path);

        if (conflict.remote) {
            item.append(button('View remote', () => runTask('view remote', () => showRemote(conflict))));
        }
        item.append(
            button('Keep mine', () => runTask('resolve', () => settle(conflict, 'mine'))),
            button('Take theirs', () => runTask('resolve', () => settle(conflict, 'theirs'))),
        );
        dom.conflictList.append(item);
    }
}

/**
 * @param {string} label
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function button(label, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
}

/**
 * @returns {void}
 */
function updateButtons() {
    const connected = api !== null;
    dom.pull.disabled = busy || !connected;
    dom.reset.disabled = busy || !connected;
    // Guard 1 is enforced in sync.push too; this just stops the button looking available.
    dom.push.disabled = busy || !connected || !state.index?.head || state.conflicts.length > 0;
    dom.connect.disabled = busy;
}

// ---------------------------------------------------------------- operations

/**
 * Runs an operation with the UI locked, and routes any failure to the log rather
 * than to an unhandled rejection.
 * @param {string} label
 * @param {() => Promise<void>} work
 * @returns {Promise<void>}
 */
async function runTask(label, work) {
    if (busy) return;
    busy = true;
    updateButtons();
    try {
        await work();
    } catch (error) {
        log.error(`${label} failed: ${describeError(error)}`);
    } finally {
        busy = false;
        render();
    }
}

/**
 * @param {object} result - whatever pull/push/replace returned
 * @returns {void}
 */
function adopt(result) {
    // A cancelled push still carries the state its pull left behind, so the fields
    // are taken as they come rather than gated on the outcome.
    if (!result) return;
    if (result.local) state.local = result.local;
    if (result.index !== undefined) state.index = result.index;
    if (result.conflicts) state.conflicts = result.conflicts;
}

const handlers = {
    onFirstPull: askFirstPull,
    confirmReplace: summary => askConfirm({
        title: 'Replace the workspace from the repo?',
        note: `${summary.unchanged} file(s) already match and will be left alone.`,
        groups: [
            { title: 'Delete locally', items: summary.toDelete, destructive: true },
            { title: 'Write from repo', items: summary.toWrite },
        ],
        requireTyped: summary.toDelete.length > 0,
        confirmLabel: 'Replace workspace',
    }),
    confirmPush: summary => askConfirm({
        title: 'Push these changes?',
        note: summary.requiresExplicitConfirm
            ? `This deletes ${summary.deleted.length} of ${summary.trackedCount} tracked files.`
            : undefined,
        groups: [
            { title: 'New', items: summary.created },
            { title: 'Modified', items: summary.updated },
            { title: 'Deleted', items: summary.deleted, destructive: true },
        ],
        requireTyped: summary.requiresExplicitConfirm,
        confirmLabel: 'Commit and push',
    }),
};

/**
 * @returns {Promise<void>}
 */
async function connect() {
    const repoUrl = dom.repoUrl.value.trim();
    const branch = dom.branch.value.trim() || 'main';
    const token = dom.token.value;
    if (!token) throw new Error('Enter a token');

    const { owner, repo } = parseRepoUrl(repoUrl);
    if (!saveSettings({ repoUrl, token, branch })) {
        log.warn('Could not save settings — this browser is blocking site storage');
    }

    const persisted = await requestPersistence();
    log.info(persisted === null
        ? 'Persistent storage: not available in this browser'
        : `Persistent storage: ${persisted ? 'granted' : 'refused (the browser may still evict this origin)'}`);

    const candidate = new GitHub({ owner, repo, branch, token });
    const metadata = await candidate.getRepo();
    api = candidate;

    dom.connection.textContent = `${metadata.full_name} · ${branch}`;
    log.info(`Connected to ${metadata.full_name} (${metadata.private ? 'private' : 'public'}), branch ${branch}`);

    state.index = await readIndex();
    state.local = await scanLocal();
    state.conflicts = [];
    if (state.index && (state.index.owner !== owner || state.index.repo !== repo || state.index.branch !== branch)) {
        log.warn(`The workspace was last synced with ${state.index.owner}/${state.index.repo} on ${state.index.branch}. Pushing now would apply its files to ${owner}/${repo} on ${branch}.`);
    }
}

/**
 * @param {{path: string, remote: string}} conflict
 * @returns {Promise<void>}
 */
async function showRemote(conflict) {
    const bytes = await api.getBlob(conflict.remote);
    dom.viewTitle.textContent = `Remote version — ${conflict.path}`;
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        text = `(${bytes.byteLength} bytes of binary content — not shown)`;
    }
    dom.viewBody.textContent = text;
    await openDialog(dom.viewDialog);
}

/**
 * @param {object} conflict
 * @param {'mine'|'theirs'} choice
 * @returns {Promise<void>}
 */
async function settle(conflict, choice) {
    await resolveConflict(api, conflict, choice);
    state.index = await readIndex();
    state.local = await scanLocal();
    state.conflicts = state.conflicts.filter(entry => entry.path !== conflict.path);
}

/**
 * @returns {Promise<void>}
 */
async function doPush() {
    const message = dom.message.value.trim();
    if (!message) throw new Error('Enter a commit message');

    let result;
    try {
        result = await push(api, message, handlers);
    } catch (error) {
        // Guard 2. Overriding it is possible, but never in one click.
        if (error.guard !== 'empty-workspace') throw error;
        const confirmed = await askConfirm({
            title: 'The workspace is empty',
            note: `${error.trackedCount} tracked file(s) are missing from OPFS. If the storage was cleared, pull to restore them. Continuing deletes all ${error.trackedCount} from the repository.`,
            groups: [{ title: 'Would be deleted', items: error.paths, destructive: true }],
            requireTyped: true,
            confirmLabel: 'Delete them from the repo',
        });
        if (!confirmed) { log.info('Push cancelled — nothing was committed'); return; }
        result = await push(api, message, { ...handlers, allowEmptyWorkspace: true });
    }

    adopt(result);
    if (result.nothingToPush) log.info('Nothing to push — the workspace matches the repo');
    if (result.commitSha) dom.message.value = '';
}

// ---------------------------------------------------------------- startup

initLog(el('log'));

const saved = loadSettings();
dom.repoUrl.value = saved.repoUrl;
dom.token.value = saved.token;
dom.branch.value = saved.branch;

dom.connect.addEventListener('click', () => runTask('Connect', connect));
dom.pull.addEventListener('click', () => runTask('Pull', async () => adopt(await pull(api, handlers))));
dom.push.addEventListener('click', () => runTask('Push', doPush));
dom.reset.addEventListener('click', () => runTask('Reset workspace', async () => {
    adopt(await replaceFromRemote(api, handlers));
}));

window.addEventListener('unhandledrejection', event => {
    log.error(`Unhandled: ${describeError(event.reason)}`);
});

if (!navigator.storage?.getDirectory) {
    log.error('OPFS is unavailable — serve this app over http://localhost or https, not file://');
} else {
    log.info('Ready. Enter a repository and token, then Connect.');
}

/**
 * Reads what is already on disk so the first paint reflects reality rather than an
 * empty workspace, which would show every tracked file as deleted.
 * @returns {Promise<void>}
 */
async function restore() {
    state.index = await readIndex();
    state.local = await scanLocal();
    if (state.index) {
        log.info(`Existing sync state: ${state.index.owner}/${state.index.repo} on ${state.index.branch} at ${String(state.index.head).slice(0, 7)}`);
    }
}

render();
if (navigator.storage?.getDirectory) {
    restore()
        .catch(error => log.error(`Could not read the workspace: ${describeError(error)}`))
        .finally(render);
}
