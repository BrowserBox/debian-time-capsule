/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * browserbox-client.js
 * Client for the BrowserBox Demo Server API.
 */

export class BrowserBoxClient {
    constructor(serverBaseUrl = '') {
        this.baseUrl = serverBaseUrl;
    }

    /**
     * Normalize server session payloads across snake_case/camelCase variants.
     * @param {any} raw
     * @returns {{loginUrl?: string, region?: string, remainingMs?: number, sessionId?: string, [key: string]: any}}
     */
    normalizeSession(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const loginUrl = source.loginUrl || source.login_url || source.loginLink || null;
        const sessionId = source.sessionId || source.session_id || source.id || null;

        let remainingMs = Number(source.remainingMs ?? source.remaining_ms);
        if (!Number.isFinite(remainingMs)) {
            const expiresAt = Number(source.expiresAt ?? source.expires_at);
            const now = Date.now();
            if (Number.isFinite(expiresAt)) {
                remainingMs = Math.max(0, expiresAt - now);
            } else {
                remainingMs = 0;
            }
        }

        return {
            ...source,
            loginUrl,
            sessionId,
            remainingMs,
            region: source.region || 'iad',
        };
    }

    /**
     * Create a new BrowserBox session.
     * @param {{clientIP?: string|null, region?: string|null}=} options
     * @returns {Promise<{loginUrl: string, region: string, remainingMs: number, sessionId: string}>}
     */
    async createSession(options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        try {
            const payload = {};
            if (options.clientIP && typeof options.clientIP === 'string') {
                payload.clientIP = options.clientIP;
            }
            if (typeof options.region === 'string' && options.region.trim()) {
                payload.region = options.region.trim().toLowerCase();
            }

            let response;
            try {
                response = await fetch(`${this.baseUrl}/api/session`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
            } catch (error) {
                const wrapped = new Error(error?.message || 'Network fetch failed', { cause: error });
                wrapped.code = (
                    typeof navigator !== 'undefined' && navigator.onLine === false
                        ? 'NETWORK_OFFLINE'
                        : 'NETWORK_FETCH_FAILED'
                );
                throw wrapped;
            }

            let data = {};
            try {
                data = await response.json();
            } catch {
                data = {};
            }
            if (!response.ok) {
                const error = new Error(data.error || `Failed to create session (${response.status})`);
                error.status = response.status;
                if (response.status === 429) {
                    error.code = 'RATE_LIMIT_EXCEEDED';
                    error.reason = typeof data.reason === 'string' ? data.reason : null;
                    error.waitMinutes = Number.isFinite(Number(data.waitMinutes))
                        ? Number(data.waitMinutes)
                        : null;
                }
                const isPoolEmpty = (
                    data?.code === 'pool_empty'
                    || (response.status === 503 && /no capacity/i.test(String(data?.error || '')))
                );
                if (isPoolEmpty) {
                    const retryAfterHeader = Number(response.headers.get('Retry-After'));
                    const retryAfterBody = Number(data.retry_after);
                    error.code = 'POOL_EMPTY';
                    error.retryAfter = Number.isFinite(retryAfterBody)
                        ? retryAfterBody
                        : (Number.isFinite(retryAfterHeader) ? retryAfterHeader : null);
                }
                throw error;
            }
            return this.normalizeSession(data);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Check whether the current demo session (identified by cookie) is still active.
     * @returns {Promise<{active: boolean, loginUrl?: string, sessionId?: string, remainingMs?: number}>}
     */
    async checkSession() {
        try {
            const response = await fetch(`${this.baseUrl}/api/session/status`, {
                method: 'GET',
                credentials: 'same-origin',
            });
            const data = await response.json();
            if (!data.active) return { active: false };
            return { active: true, ...this.normalizeSession(data) };
        } catch {
            // Network error — assume session may still be alive to avoid false expiry dialogs
            return { active: true };
        }
    }

    /**
     * Notify server that the page is disconnecting.
     * @param {string} sessionId
     * @param {{mode?: 'hard'|'defer'}=} options
     */
    async notifyDisconnect(sessionId, options = {}) {
        if (!sessionId) {
            return;
        }

        const url = `${this.baseUrl}/api/session/disconnect`;
        const mode = typeof options.mode === 'string' ? options.mode.trim().toLowerCase() : 'defer';
        const payload = JSON.stringify({
            sessionId,
            mode: (mode === 'hard' || mode === 'defer') ? mode : 'defer',
        });

        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            try {
                const blob = new Blob([payload], { type: 'application/json' });
                navigator.sendBeacon(url, blob);
                return;
            } catch {
                // Fall back to fetch keepalive.
            }
        }

        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true,
            });
        } catch {
            // Disconnect failures are tolerated.
        }
    }
}
