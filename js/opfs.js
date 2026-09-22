// Reading and writing the OPFS root, plus this app's own index.json.
//
// The root is shared with the editor app, so nothing here assumes a file came
// from us, and nothing is written outside .gitsync/.

import { STORE_DIR, INDEX_FILE, isIgnored } from './config.js';

/**
 * @returns {Promise<FileSystemDirectoryHandle>}
 * @throws {Error} when OPFS is unreachable, which in practice means an insecure context
 */
async function opfsRoot() {
    if (!navigator.storage?.getDirectory) {
        throw new Error('OPFS unavailable — serve this app over http://localhost or https');
    }
    return navigator.storage.getDirectory();
}

/**
 * Drains a directory iterator into an array before anything else touches that
 * directory: concurrent values() and getDirectoryHandle() on the same handle
 * deadlock in Chromium.
 * @param {FileSystemDirectoryHandle} directory
 * @returns {Promise<Array<FileSystemHandle>>}
 */
async function entriesOf(directory) {
    const entries = [];
    for await (const entry of directory.values()) entries.push(entry);
    return entries;
}

/**
 * @param {FileSystemDirectoryHandle} directory
 * @param {string} prefix
 * @param {Array<{path: string, handle: FileSystemFileHandle}>} found
 * @returns {Promise<void>}
 */
async function walk(directory, prefix, found) {
    for (const entry of await entriesOf(directory)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === 'file') {
            if (!isIgnored(path)) found.push({ path, handle: entry });
        } else if (path !== STORE_DIR) {
            await walk(entry, path, found);
        }
    }
}

/**
 * Every syncable file at the OPFS root, recursively. Ignored paths and this app's
 * own directory are left out.
 * @returns {Promise<Array<{path: string, handle: FileSystemFileHandle}>>}
 */
export async function walkRoot() {
    const found = [];
    await walk(await opfsRoot(), '', found);
    return found;
}

/**
 * @param {FileSystemFileHandle} handle
 * @returns {Promise<Uint8Array>}
 */
export async function readBytes(handle) {
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

/**
 * Walks to a path's parent directory.
 * @param {string} path
 * @param {boolean} create - create missing directories along the way
 * @returns {Promise<{parent: FileSystemDirectoryHandle, name: string}|null>} null when
 *   create is false and some directory on the way does not exist
 */
async function parentOf(path, create) {
    const parts = path.split('/');
    const name = parts.pop();
    let directory = await opfsRoot();
    for (const part of parts) {
        try {
            directory = await directory.getDirectoryHandle(part, { create });
        } catch {
            return null;
        }
    }
    return { parent: directory, name };
}

/**
 * @param {string} path
 * @param {Uint8Array} bytes
 * @returns {Promise<void>}
 */
export async function writeFile(path, bytes) {
    const { parent, name } = await parentOf(path, true);
    const handle = await parent.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
        await writable.write(bytes);
    } finally {
        await writable.close();
    }
}

/**
 * Deletes a file, treating "already gone" as success.
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function removeFile(path) {
    const location = await parentOf(path, false);
    if (!location) return;
    try {
        await location.parent.removeEntry(location.name);
    } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
    }
}

/**
 * Removes directories left empty by deletions, deepest first. Never touches
 * .gitsync/, and stops short of the root itself.
 * @returns {Promise<number>} how many directories were removed
 */
export async function pruneEmptyDirectories() {
    let removed = 0;
    async function prune(directory, prefix) {
        for (const entry of await entriesOf(directory)) {
            if (entry.kind !== 'directory') continue;
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (path === STORE_DIR) continue;
            await prune(entry, path);
            if ((await entriesOf(entry)).length === 0) {
                await directory.removeEntry(entry.name);
                removed++;
            }
        }
    }
    await prune(await opfsRoot(), '');
    return removed;
}

/**
 * Reads .gitsync/index.json.
 * @returns {Promise<object|null>} null when absent or unreadable — both of which mean
 *   "no merge base", which the caller must treat as clone-not-delete
 */
export async function readIndex() {
    try {
        const root = await opfsRoot();
        const store = await root.getDirectoryHandle(STORE_DIR, { create: false });
        const handle = await store.getFileHandle(INDEX_FILE, { create: false });
        const parsed = JSON.parse(await (await handle.getFile()).text());
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * @param {object} index
 * @returns {Promise<void>}
 */
export async function writeIndex(index) {
    const root = await opfsRoot();
    const store = await root.getDirectoryHandle(STORE_DIR, { create: true });
    const handle = await store.getFileHandle(INDEX_FILE, { create: true });
    const writable = await handle.createWritable();
    try {
        await writable.write(JSON.stringify(index, null, 2));
    } finally {
        await writable.close();
    }
}

/**
 * Asks the browser not to evict this origin's storage. The two apps share an
 * origin, so a grant protects the editor's notes too. Advisory only: the result is
 * reported and nothing depends on it.
 * @returns {Promise<boolean|null>} null when the browser has no opinion to offer
 */
export async function requestPersistence() {
    if (!navigator.storage?.persist) return null;
    try {
        if (await navigator.storage.persisted?.()) return true;
        return await navigator.storage.persist();
    } catch {
        return null;
    }
}
