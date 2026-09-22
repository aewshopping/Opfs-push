// Git-compatible blob hashing, and the base64 conversions the GitHub API needs.

/**
 * The git blob sha of some bytes: sha1("blob <byteLength>\0" + bytes), hashed over
 * bytes rather than a string so the result compares directly against the shas
 * GitHub returns in the tree API, for text and binary alike.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} 40-character hex digest
 */
export async function gitBlobSha(bytes) {
    const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const payload = new Uint8Array(header.length + bytes.byteLength);
    payload.set(header, 0);
    payload.set(bytes, header.length);
    const digest = await crypto.subtle.digest('SHA-1', payload);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Comfortably under the argument-count limit that makes fromCharCode throw.
const CHUNK = 0x8000;

/**
 * Bytes to base64, in chunks: String.fromCharCode(...bytes) overflows the call
 * stack on a file of any real size.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Base64 to bytes. GitHub wraps blob payloads at 60 characters, so whitespace goes
 * first — atob rejects it.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
    const binary = atob(base64.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
