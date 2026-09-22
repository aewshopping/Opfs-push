// Every GitHub REST call the app makes, plus the pool that bounds concurrency.

import { API_BASE, FETCH_CONCURRENCY } from './config.js';
import { bytesToBase64, base64ToBytes } from './hash.js';

/**
 * Turns a failed response into an Error carrying the status and whatever GitHub
 * said, so the log line is actionable rather than just "request failed".
 * @param {Response} response
 * @param {string} path
 * @returns {Promise<Error>}
 */
async function httpError(response, path) {
    let detail = '';
    try {
        const body = await response.json();
        detail = body?.message ?? '';
        if (Array.isArray(body?.errors) && body.errors.length > 0) {
            detail += ` (${body.errors.map(item => item.message ?? item.code).join('; ')})`;
        }
    } catch {
        // A non-JSON error body (a proxy page, say). The status line will have to do.
    }
    const error = new Error(`${response.status} ${response.statusText} on ${path}${detail ? ` — ${detail}` : ''}`);
    error.status = response.status;
    return error;
}

/**
 * Runs an async worker over items, at most `limit` in flight.
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {number} [limit]
 * @returns {Promise<R[]>}
 */
export async function pooled(items, worker, limit = FETCH_CONCURRENCY) {
    const results = new Array(items.length);
    let next = 0;
    async function drain() {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
    return results;
}

export class GitHub {
    /**
     * @param {{owner: string, repo: string, branch: string, token: string}} options
     */
    constructor({ owner, repo, branch, token }) {
        this.owner = owner;
        this.repo = repo;
        this.branch = branch;
        this.token = token;
    }

    get base() {
        return `/repos/${this.owner}/${this.repo}`;
    }

    /**
     * @param {string} path - API path beginning with a slash
     * @param {RequestInit} [options]
     * @returns {Promise<any>} parsed JSON, or null for 204
     */
    async request(path, options = {}) {
        const response = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Authorization': `Bearer ${this.token}`,
                ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...options.headers,
            },
        });
        if (!response.ok) throw await httpError(response, path);
        return response.status === 204 ? null : response.json();
    }

    /**
     * @param {string} path
     * @param {any} body
     * @returns {Promise<any>}
     */
    post(path, body) {
        return this.request(path, { method: 'POST', body: JSON.stringify(body) });
    }

    /** @returns {Promise<any>} repository metadata; the cheapest check that the token works */
    getRepo() {
        return this.request(this.base);
    }

    /**
     * The branch head.
     * @returns {Promise<string|null>} commit sha, or null when the branch has no commits yet
     */
    async getHead() {
        try {
            const ref = await this.request(`${this.base}/git/ref/heads/${encodeURIComponent(this.branch)}`);
            return ref.object.sha;
        } catch (error) {
            if (error.status === 404 || error.status === 409) return null;
            throw error;
        }
    }

    /**
     * @param {string} commitSha
     * @returns {Promise<string>} the sha of that commit's tree
     */
    async getCommitTree(commitSha) {
        const commit = await this.request(`${this.base}/git/commits/${commitSha}`);
        return commit.tree.sha;
    }

    /**
     * @param {string} treeSha
     * @returns {Promise<{tree: any[], truncated: boolean}>}
     */
    getTree(treeSha) {
        return this.request(`${this.base}/git/trees/${treeSha}?recursive=1`);
    }

    /**
     * @param {string} blobSha
     * @returns {Promise<Uint8Array>}
     */
    async getBlob(blobSha) {
        const blob = await this.request(`${this.base}/git/blobs/${blobSha}`);
        if (blob.encoding !== 'base64') {
            throw new Error(`Unexpected blob encoding "${blob.encoding}" for ${blobSha}`);
        }
        return base64ToBytes(blob.content);
    }

    /**
     * @param {Uint8Array} bytes
     * @returns {Promise<string>} the new blob's sha
     */
    async createBlob(bytes) {
        const blob = await this.post(`${this.base}/git/blobs`, {
            content: bytesToBase64(bytes),
            encoding: 'base64',
        });
        return blob.sha;
    }

    /**
     * @param {string|null} baseTreeSha - null when the repo has no commits yet
     * @param {any[]} entries - tree entries; a null sha deletes that path
     * @returns {Promise<string>} the new tree's sha
     */
    async createTree(baseTreeSha, entries) {
        const tree = await this.post(`${this.base}/git/trees`, {
            ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
            tree: entries,
        });
        return tree.sha;
    }

    /**
     * @param {string} message
     * @param {string} treeSha
     * @param {string[]} parents - empty for the first commit in a repo
     * @returns {Promise<string>} the new commit's sha
     */
    async createCommit(message, treeSha, parents) {
        const commit = await this.post(`${this.base}/git/commits`, { message, tree: treeSha, parents });
        return commit.sha;
    }

    /**
     * Points the branch at a commit, creating the ref when the branch is new.
     * @param {string} commitSha
     * @param {boolean} branchExists
     * @returns {Promise<void>}
     */
    async setHead(commitSha, branchExists) {
        if (!branchExists) {
            await this.post(`${this.base}/git/refs`, { ref: `refs/heads/${this.branch}`, sha: commitSha });
            return;
        }
        await this.request(`${this.base}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
            method: 'PATCH',
            body: JSON.stringify({ sha: commitSha, force: false }),
        });
    }
}
