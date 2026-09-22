// The sync model: scan, classify, pull, push, resolve.
//
// Every decision rests on three shas per path — L (local), B (the base recorded in
// index.json) and R (remote). See "Sync model" in plans/app setup.md.

import { MAX_SILENT_DELETES, MAX_SILENT_DELETE_RATIO, isIgnored } from './config.js';
import { gitBlobSha } from './hash.js';
import { log } from './log.js';
import { pooled } from './github.js';
import {
    walkRoot, readBytes, writeFile, removeFile, pruneEmptyDirectories, readIndex, writeIndex,
} from './opfs.js';

/**
 * Hashes every syncable file at the OPFS root. Bytes are read to hash and then
 * dropped; the handle is kept so content can be re-read only when it is needed.
 * @returns {Promise<Map<string, {sha: string, handle: FileSystemFileHandle}>>}
 */
export async function scanLocal() {
    const files = new Map();
    for (const { path, handle } of await walkRoot()) {
        files.set(path, { sha: await gitBlobSha(await readBytes(handle)), handle });
    }
    return files;
}

/**
 * The branch head, its tree, and every blob in it.
 * @param {import('./github.js').GitHub} api
 * @returns {Promise<{head: string|null, treeSha: string|null, files: Map<string, {sha: string, mode: string}>, branchExists: boolean}>}
 */
export async function fetchRemote(api) {
    const head = await api.getHead();
    if (!head) {
        return { head: null, treeSha: null, files: new Map(), branchExists: false };
    }
    const treeSha = await api.getCommitTree(head);
    const tree = await api.getTree(treeSha);
    if (tree.truncated) {
        throw new Error('The repository tree is too large to read in one response — this app cannot sync it');
    }

    const files = new Map();
    const skipped = [];
    for (const entry of tree.tree) {
        if (entry.type === 'tree') continue;
        if (entry.type !== 'blob') { skipped.push(`${entry.path} (${entry.type})`); continue; }
        if (isIgnored(entry.path)) continue;
        files.set(entry.path, { sha: entry.sha, mode: entry.mode });
    }
    if (skipped.length > 0) log.warn(`Skipped ${skipped.length} non-file entries: ${skipped.join(', ')}`);
    return { head, treeSha, files, branchExists: true };
}

/**
 * Sorts every known path into one of the four cases.
 * @param {Map<string, {sha: string}>} local
 * @param {Record<string, {sha: string}>} baseFiles
 * @param {Map<string, {sha: string}>} remote
 * @returns {{inSync: any[], fromRemote: any[], fromLocal: any[], conflicts: any[]}}
 */
export function classify(local, baseFiles, remote) {
    const plan = { inSync: [], fromRemote: [], fromLocal: [], conflicts: [] };
    const paths = new Set([...local.keys(), ...Object.keys(baseFiles), ...remote.keys()]);
    for (const path of [...paths].sort()) {
        const entry = {
            path,
            local: local.get(path)?.sha ?? null,
            base: baseFiles[path]?.sha ?? null,
            remote: remote.get(path)?.sha ?? null,
        };
        if (entry.local === entry.remote) plan.inSync.push(entry);
        else if (entry.local === entry.base) plan.fromRemote.push(entry);
        else if (entry.remote === entry.base) plan.fromLocal.push(entry);
        else plan.conflicts.push(entry);
    }
    return plan;
}

/**
 * Builds the next index.files. Every path takes the remote sha as its new base,
 * except unresolved conflicts, which keep the old one so the conflict survives a
 * reload and is re-detected on the next pull.
 * @returns {Record<string, {sha: string, mode: string}>}
 */
function nextBaseFiles(plan, baseFiles, remote) {
    const files = {};
    const record = (path, sha, mode) => {
        if (!sha) return;
        files[path] = { sha, mode: mode ?? baseFiles[path]?.mode ?? '100644' };
    };
    for (const entry of [...plan.inSync, ...plan.fromRemote, ...plan.fromLocal]) {
        record(entry.path, entry.remote, remote.get(entry.path)?.mode);
    }
    for (const entry of plan.conflicts) {
        record(entry.path, entry.base, baseFiles[entry.path]?.mode);
    }
    return files;
}

/**
 * @param {import('./github.js').GitHub} api
 * @param {object} index
 * @returns {object} index with the identity fields refreshed
 */
function stamp(api, index) {
    return { ...index, owner: api.owner, repo: api.repo, branch: api.branch };
}

/**
 * Pulls the branch into OPFS.
 *
 * With no index.json and a non-empty workspace it cannot tell leftovers from
 * intent, so it asks first — see "First pull into a non-empty workspace".
 * @param {import('./github.js').GitHub} api
 * @param {{onFirstPull?: (count: number) => Promise<'replace'|'adopt'|'cancel'>, confirmReplace?: Function}} [handlers]
 * @returns {Promise<{cancelled?: boolean, local?: Map, index?: object, plan?: object, conflicts?: any[], remote?: object}>}
 */
export async function pull(api, handlers = {}) {
    let local = await scanLocal();
    const index = await readIndex();

    if (!index && local.size > 0) {
        const choice = handlers.onFirstPull ? await handlers.onFirstPull(local.size) : 'cancel';
        if (choice === 'cancel') return { cancelled: true };
        if (choice === 'replace') return replaceFromRemote(api, handlers);
        log.info(`Adopting ${local.size} existing file(s) in the workspace`);
    }

    const baseFiles = index?.files ?? {};
    const trackedCount = Object.keys(baseFiles).length;
    if (local.size === 0 && trackedCount > 0) {
        log.warn(`Workspace is empty but ${trackedCount} file(s) are tracked — the storage looks to have been cleared. Re-cloning from the repo.`);
    }

    const remote = await fetchRemote(api);
    if (!remote.branchExists) log.warn(`Branch "${api.branch}" has no commits yet`);

    const plan = classify(local, baseFiles, remote.files);

    const toWrite = plan.fromRemote.filter(entry => entry.remote !== null);
    const toDelete = plan.fromRemote.filter(entry => entry.remote === null);
    await pooled(toWrite, async entry => writeFile(entry.path, await api.getBlob(entry.remote)));
    for (const entry of toDelete) await removeFile(entry.path);
    if (toDelete.length > 0) await pruneEmptyDirectories();

    await writeIndex(stamp(api, {
        head: remote.head,
        treeSha: remote.treeSha,
        files: nextBaseFiles(plan, baseFiles, remote.files),
    }));

    if (toWrite.length + toDelete.length > 0) local = await scanLocal();
    log.info(`Pulled: ${toWrite.length} written, ${toDelete.length} deleted, ${plan.conflicts.length} conflict(s)`);

    return { local, index: await readIndex(), plan, conflicts: plan.conflicts, remote };
}

/**
 * Makes the workspace exactly match the repo. Byte-identical files are left alone,
 * so this costs nothing for anything already in agreement.
 * @param {import('./github.js').GitHub} api
 * @param {{confirmReplace?: (summary: object) => Promise<boolean>}} [handlers]
 * @returns {Promise<object>}
 */
export async function replaceFromRemote(api, handlers = {}) {
    const local = await scanLocal();
    const remote = await fetchRemote(api);

    const toDelete = [...local.keys()].filter(path => !remote.files.has(path)).sort();
    const toWrite = [...remote.files.entries()]
        .filter(([path, entry]) => local.get(path)?.sha !== entry.sha)
        .sort(([a], [b]) => a.localeCompare(b));

    if (handlers.confirmReplace) {
        const summary = { toDelete, toWrite: toWrite.map(([path]) => path), unchanged: local.size - toDelete.length };
        if (!await handlers.confirmReplace(summary)) return { cancelled: true };
    }

    await pooled(toWrite, async ([path, entry]) => writeFile(path, await api.getBlob(entry.sha)));
    for (const path of toDelete) await removeFile(path);
    if (toDelete.length > 0) await pruneEmptyDirectories();

    const files = {};
    for (const [path, entry] of remote.files) files[path] = { sha: entry.sha, mode: entry.mode };
    await writeIndex(stamp(api, { head: remote.head, treeSha: remote.treeSha, files }));

    log.info(`Workspace replaced from repo: ${toWrite.length} written, ${toDelete.length} deleted`);
    const fresh = await scanLocal();
    return {
        local: fresh,
        index: await readIndex(),
        plan: classify(fresh, files, remote.files),
        conflicts: [],
        remote,
    };
}

/**
 * Commits local changes. Pulls first, always, then shows everything it is about to
 * do and waits for confirmation. See "Safeguards" for the four guards applied here.
 * @param {import('./github.js').GitHub} api
 * @param {string} message
 * @param {{confirmPush: (summary: object) => Promise<boolean>, onFirstPull?: Function, confirmReplace?: Function}} handlers
 * @returns {Promise<object>}
 */
export async function push(api, message, handlers = {}) {
    const index = await readIndex();
    // Guard 1: without a base sha per path, "deleted" and "never seen" are the same
    // shape. Refuse rather than guess.
    if (!index?.head) throw new Error('No sync state yet — pull before pushing');

    const tracked = Object.keys(index.files ?? {});
    const current = await scanLocal();
    // Guard 2: the signature of cleared storage, never of an intentional push. The
    // caller may override it, but the error carries what it would take to do so
    // knowingly rather than in one click.
    if (current.size === 0 && tracked.length > 0 && !handlers.allowEmptyWorkspace) {
        const error = new Error(`Workspace is empty but ${tracked.length} file(s) are tracked. This looks like the storage was cleared rather than emptied on purpose — pull to restore it.`);
        error.guard = 'empty-workspace';
        error.trackedCount = tracked.length;
        error.paths = tracked.sort();
        throw error;
    }

    const state = await pull(api, handlers);
    if (state.cancelled) return { cancelled: true };
    if (state.conflicts.length > 0) {
        throw new Error(`Resolve ${state.conflicts.length} conflict(s) before pushing: ${state.conflicts.map(entry => entry.path).join(', ')}`);
    }

    const changes = state.plan.fromLocal;
    const created = changes.filter(entry => entry.local && !entry.base);
    const updated = changes.filter(entry => entry.local && entry.base);
    const deleted = changes.filter(entry => !entry.local);
    if (created.length + updated.length + deleted.length === 0) {
        return { nothingToPush: true, ...state };
    }

    // Guards 3 and 4: every push is previewed; a large deletion says so explicitly.
    const trackedAfterPull = Object.keys(state.index.files ?? {}).length;
    const summary = {
        created: created.map(entry => entry.path),
        updated: updated.map(entry => entry.path),
        deleted: deleted.map(entry => entry.path),
        requiresExplicitConfirm: deleted.length > MAX_SILENT_DELETES
            || (trackedAfterPull > 0 && deleted.length / trackedAfterPull > MAX_SILENT_DELETE_RATIO),
        trackedCount: trackedAfterPull,
    };
    if (!await handlers.confirmPush(summary)) {
        log.info('Push cancelled — nothing was committed');
        return { cancelled: true, ...state };
    }

    const writes = [...created, ...updated];
    const blobShas = await pooled(writes, async entry =>
        api.createBlob(await readBytes(state.local.get(entry.path).handle)));

    const modeOf = path => state.index.files?.[path]?.mode ?? '100644';
    const entries = [
        ...writes.map((entry, i) => ({ path: entry.path, mode: modeOf(entry.path), type: 'blob', sha: blobShas[i] })),
        ...deleted.map(entry => ({ path: entry.path, mode: modeOf(entry.path), type: 'blob', sha: null })),
    ];

    const treeSha = await api.createTree(state.index.treeSha, entries);
    const commitSha = await api.createCommit(message, treeSha, state.index.head ? [state.index.head] : []);
    try {
        await api.setHead(commitSha, state.remote.branchExists);
    } catch (error) {
        if (error.status === 422) {
            throw new Error('The branch moved while this push was being built — pull and try again');
        }
        throw error;
    }

    const files = { ...state.index.files };
    writes.forEach((entry, i) => { files[entry.path] = { sha: blobShas[i], mode: modeOf(entry.path) }; });
    for (const entry of deleted) delete files[entry.path];
    await writeIndex(stamp(api, { head: commitSha, treeSha, files }));

    log.info(`Pushed ${commitSha.slice(0, 7)}: ${created.length} new, ${updated.length} modified, ${deleted.length} deleted`);
    return { commitSha, summary, local: await scanLocal(), index: await readIndex(), plan: state.plan, conflicts: [], remote: state.remote };
}

/**
 * Settles one conflict. Both choices set the base to the remote sha; they differ
 * only in whether the local file is left alone or overwritten.
 * @param {import('./github.js').GitHub} api
 * @param {{path: string, remote: string|null}} conflict
 * @param {'mine'|'theirs'} choice
 * @returns {Promise<void>}
 */
export async function resolveConflict(api, conflict, choice) {
    const index = await readIndex();
    if (!index) throw new Error('No sync state — pull first');

    if (choice === 'theirs') {
        if (conflict.remote) await writeFile(conflict.path, await api.getBlob(conflict.remote));
        else await removeFile(conflict.path);
    }

    const files = { ...index.files };
    if (conflict.remote) files[conflict.path] = { sha: conflict.remote, mode: files[conflict.path]?.mode ?? '100644' };
    else delete files[conflict.path];
    await writeIndex({ ...index, files });

    log.info(`Conflict on ${conflict.path} resolved — kept ${choice === 'mine' ? 'the local version' : 'the remote version'}`);
}

/**
 * One row per known path, for the file list.
 * @returns {Array<{path: string, status: 'new'|'modified'|'deleted'|'conflict'|'unchanged'}>}
 */
export function statusList(local, index, conflicts = []) {
    const conflicted = new Set(conflicts.map(entry => entry.path));
    const baseFiles = index?.files ?? {};
    const paths = [...new Set([...local.keys(), ...Object.keys(baseFiles)])].sort();
    return paths.map(path => {
        const localSha = local.get(path)?.sha ?? null;
        const baseSha = baseFiles[path]?.sha ?? null;
        let status = 'unchanged';
        if (conflicted.has(path)) status = 'conflict';
        else if (localSha && !baseSha) status = 'new';
        else if (!localSha && baseSha) status = 'deleted';
        else if (localSha !== baseSha) status = 'modified';
        return { path, status };
    });
}
