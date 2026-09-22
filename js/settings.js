// Repo URL and token, persisted in localStorage. The token is never logged, never
// written to a file, and never put in a URL.

import { DEFAULT_BRANCH } from './config.js';

const KEY_REPO = 'gitsync.repoUrl';
const KEY_TOKEN = 'gitsync.token';
const KEY_BRANCH = 'gitsync.branch';

/**
 * localStorage throws rather than returning null when site data is blocked, so
 * every access goes through here.
 * @param {string} key
 * @returns {string}
 */
function read(key) {
    try {
        return localStorage.getItem(key) ?? '';
    } catch {
        return '';
    }
}

/**
 * @returns {{repoUrl: string, token: string, branch: string}}
 */
export function loadSettings() {
    return {
        repoUrl: read(KEY_REPO),
        token: read(KEY_TOKEN),
        branch: read(KEY_BRANCH) || DEFAULT_BRANCH,
    };
}

/**
 * @param {{repoUrl: string, token: string, branch: string}} settings
 * @returns {boolean} false when storage is unavailable, so the caller can say so
 */
export function saveSettings({ repoUrl, token, branch }) {
    try {
        localStorage.setItem(KEY_REPO, repoUrl);
        localStorage.setItem(KEY_TOKEN, token);
        localStorage.setItem(KEY_BRANCH, branch);
        return true;
    } catch {
        return false;
    }
}

/**
 * Reads owner and repo from https://github.com/owner/repo[.git], an ssh remote, or
 * a bare owner/repo.
 * @param {string} input
 * @returns {{owner: string, repo: string}}
 * @throws {Error} when the input matches none of those shapes
 */
export function parseRepoUrl(input) {
    const trimmed = (input ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
    if (!trimmed) throw new Error('Enter a repository URL');

    const patterns = [
        /^([\w.-]+)\/([\w.-]+)$/,                      // owner/repo
        /^git@[\w.-]+:([\w.-]+)\/([\w.-]+)$/,          // git@github.com:owner/repo
        /^https?:\/\/[\w.-]+\/([\w.-]+)\/([\w.-]+)$/,  // https://github.com/owner/repo
    ];
    for (const pattern of patterns) {
        const match = trimmed.match(pattern);
        if (match) return { owner: match[1], repo: match[2] };
    }
    throw new Error(`Could not read owner/repo from "${input}"`);
}
