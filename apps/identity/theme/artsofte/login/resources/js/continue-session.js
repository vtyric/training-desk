/** Resume only the server-rendered, known session-conflict recovery link. */
async function continueSession() {
    const link = globalThis.document.getElementById('identity-continue-session');
    if (!link) return;
    const target = new globalThis.URL(link.href, globalThis.location.href);
    // Never turn this convenience redirect into an untrusted return URL or log out SSO.
    if (
        target.origin !== globalThis.location.origin ||
        !/\/realms\/[^/]+\/login-actions\/restart$/.test(target.pathname) ||
        target.searchParams.get('skip_logout') !== 'true' ||
        !target.searchParams.get('tab_id')
    )
        return;
    try {
        const bytes = new globalThis.TextEncoder().encode(target.href);
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        const key =
            'identity:continue:' + [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
        // One automatic attempt per authentication flow. Only a timestamp/hash is stored, never tokens.
        if (globalThis.sessionStorage.getItem(key)) return;
        globalThis.sessionStorage.setItem(key, String(Date.now()));
        globalThis.location.replace(target.href);
    } catch {
        // Blocked storage/crypto leaves the normal Keycloak continue link usable.
    }
}
void continueSession();
