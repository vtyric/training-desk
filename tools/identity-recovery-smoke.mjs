import assert from 'node:assert/strict';
import { URLSearchParams } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
const base = (process.env.IDENTITY_PUBLIC_URL || 'http://localhost:8081').replace(/\/$/, '');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Recovery smoke is local only');
const cookies = new Map();
const decode = (s) => s.replaceAll('&amp;', '&').replaceAll('&quot;', '"');
async function request(url, options = {}) {
    assert.equal(new URL(url).origin, base);
    const r = await fetch(url, {
        ...options,
        redirect: 'manual',
        headers: { ...options.headers, cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of r.headers.getSetCookie()) {
        const part = c.split(';')[0];
        const i = part.indexOf('=');
        if (part.slice(i + 1)) cookies.set(part.slice(0, i), part.slice(i + 1));
        else cookies.delete(part.slice(0, i));
    }
    return r;
}
async function form() {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const redirect = 'http://localhost:8080/docs/static/oauth2-redirect.html';
    const url =
        base +
        '/realms/training/protocol/openid-connect/auth?' +
        new URLSearchParams({
            client_id: 'service-desk-swagger',
            response_type: 'code',
            redirect_uri: redirect,
            scope: 'openid',
            state,
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
        });
    const response = await request(url);
    assert.equal(response.status, 200);
    const html = await response.text();
    const action = decode(html.match(/<form[^>]*id="identity-form"[^>]*action="([^"]+)"/)[1]);
    return { verifier, state, redirect, action };
}
const first = await form();
const second = await form();
const submit = (action, username, password) =>
    request(action, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password, credentialId: '' }),
    });
assert.equal((await submit(first.action, 'alice', process.env.LDAP_ALICE_PASSWORD)).status, 302);
const conflict = await submit(second.action, 'support', process.env.LDAP_SUPPORT_PASSWORD);
assert.equal(conflict.status, 400);
const html = await conflict.text();
assert.ok(html.includes('id="identity-continue-session"'), 'Known conflict has automatic continuation');
assert.ok(!html.includes('Для другого пользователя'));
const resume = decode(html.match(/id="identity-continue-session"\s+href="([^"]+)"/)[1]);
const target = new URL(resume, base);
assert.equal(target.origin, base);
assert.equal(target.searchParams.get('skip_logout'), 'true');
let next = await request(target);
for (let hops = 0; hops < 4 && [302, 303].includes(next.status); hops++) {
    const location = new URL(next.headers.get('location'), base);
    if (location.origin === 'http://localhost:8080') {
        assert.equal(location.pathname, new URL(second.redirect).pathname);
        assert.equal(location.searchParams.get('state'), second.state);
        assert.ok(location.searchParams.get('code'));
        const exchanged = await fetch(base + '/realms/training/protocol/openid-connect/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: 'service-desk-swagger',
                redirect_uri: second.redirect,
                code: location.searchParams.get('code'),
                code_verifier: second.verifier,
            }),
        });
        assert.equal(exchanged.status, 200, 'Original PKCE code verifier retained');
        const tokens = await exchanged.json();
        const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url'));
        console.log(
            'Concurrent auth recovery passed: original state, redirect and PKCE preserved; account:',
            claims.preferred_username,
            'name:',
            claims.name
        );
        const logout = new URL(base + '/realms/training/protocol/openid-connect/logout');
        logout.search = new URLSearchParams({
            id_token_hint: tokens.id_token,
            client_id: 'service-desk-swagger',
            post_logout_redirect_uri: 'http://localhost:8080/docs/',
        }).toString();
        assert.equal((await request(logout)).status, 302);
        process.exit(0);
    }
    next = await request(location);
}
throw Error('Recovery did not finish authorization; HTTP ' + next.status);
