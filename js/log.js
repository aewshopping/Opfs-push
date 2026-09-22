// The on-page log. Every failure lands here rather than in an unhandled rejection.

let logElement = null;

/**
 * @param {HTMLElement} element - the <div> that holds the log lines
 * @returns {void}
 */
export function initLog(element) {
    logElement = element;
}

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @returns {void}
 */
function append(level, message) {
    if (!logElement) return;
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    line.textContent = `${new Date().toTimeString().slice(0, 8)}  ${message}`;
    logElement.append(line);
    logElement.scrollTop = logElement.scrollHeight;
}

export const log = {
    info: message => append('info', message),
    warn: message => append('warn', message),
    error: message => append('error', message),
};

/**
 * A readable one-liner for anything that was thrown, not just Error instances.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}
