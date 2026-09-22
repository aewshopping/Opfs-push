// Constants and the ignore-pattern matcher. Nothing here is secret: this file is
// served publicly from GitHub Pages.

export const API_BASE = 'https://api.github.com';
export const DEFAULT_BRANCH = 'main';

// This app's own state. The only thing at the OPFS root that belongs to us.
export const STORE_DIR = '.gitsync';
export const INDEX_FILE = 'index.json';

// Never synced, in either direction. The *.gypsum entries are gypsum's mid-save
// artifacts: they exist only between a write and its verification, so committing
// them would add a file and then remove it again seconds later.
export const IGNORE_PATTERNS = [
    `${STORE_DIR}/**`,
    '**/*-save.gypsum',
    '**/*-autosave.gypsum',
    '**/*-temp.gypsum',
];

// Deletion guards — see "Safeguards" in plans/app setup.md. Retune if noisy;
// do not remove the checks that read them.
export const MAX_SILENT_DELETES = 5;
export const MAX_SILENT_DELETE_RATIO = 0.2;

// Parallel blob requests. GitHub tolerates more, but this keeps a large pull from
// monopolising the browser's connection pool.
export const FETCH_CONCURRENCY = 6;

const REGEX_SPECIALS = '\\^$.|?+()[]{}';

/**
 * Translates one glob into an anchored RegExp. `**` spans directories, `*` does
 * not, and a leading `**​/` also matches at the root so `**​/*-temp.gypsum`
 * catches `x-temp.gypsum` as well as `a/b/x-temp.gypsum`.
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char !== '*') {
            out += REGEX_SPECIALS.includes(char) ? `\\${char}` : char;
            continue;
        }
        if (pattern[i + 1] !== '*') { out += '[^/]*'; continue; }
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
    }
    return new RegExp(`^${out}$`);
}

const IGNORE_REGEXPS = IGNORE_PATTERNS.map(globToRegExp);

/**
 * True when a path must not be synced.
 * @param {string} path - OPFS path, relative to the root, forward-slashed.
 * @returns {boolean}
 */
export function isIgnored(path) {
    return IGNORE_REGEXPS.some(re => re.test(path));
}
