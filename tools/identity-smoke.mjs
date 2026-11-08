import { URLSearchParams } from 'node:url';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const idp = (process.env.IDENTITY_PUBLIC_URL || 'http://localhost:8081').replace(/\/$/, '');
const desk = (process.env.DOCKER_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const issuer = `${idp}/realms/training`;
const metadata = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
assert.equal(metadata.issuer, issuer);
const cookies = new Map();
const decode = (s) => s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
async function identityRequest(url, options = {}) {
    assert.equal(new URL(url).origin, new URL(idp).origin, 'Credentials/cookies stay inside configured Identity');
    const response = await fetch(url, {
        ...options,
        redirect: 'manual',
        headers: {
            ...options.headers,
            ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        },
    });
    for (const c of response.headers.getSetCookie()) {
        const first = c.split(';')[0];
        const i = first.indexOf('=');
        cookies.set(first.slice(0, i), first.slice(i + 1));
    }
    return response;
}
async function authorize(clientId, redirectUri, password, username = 'alice', extra = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid',
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        ...extra,
    }).toString();
    let response = await identityRequest(url);
    let neededPassword = false;
    if (response.status === 200) {
        neededPassword = true;
        const html = await response.text();
        assert.ok(html.includes('Artsofte Federation'), 'Custom Identity theme rendered');
        const action = /<form[^>]*id="identity-form"[^>]*action="([^"]+)"/.exec(html)?.[1];
        assert.ok(action, 'Identity login form exists');
        if (!password) throw new Error('Shared SSO session was not reused');
        response = await identityRequest(decode(action), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username, password, credentialId: '' }),
        });
    }
    assert.ok([302, 303].includes(response.status), `Authorization failed (${response.status})`);
    const callback = new URL(response.headers.get('location'));
    assert.equal(callback.origin, new URL(redirectUri).origin);
    assert.equal(callback.pathname, new URL(redirectUri).pathname);
    assert.equal(callback.searchParams.get('state'), state);
    assert.ok(callback.searchParams.get('code'));
    const tokensResponse = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(redirectUri).origin },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            redirect_uri: redirectUri,
            code: callback.searchParams.get('code'),
            code_verifier: verifier,
        }),
    });
    assert.equal(tokensResponse.status, 200, 'PKCE token exchange');
    const tokens = await tokensResponse.json();
    const verified = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(metadata.jwks_uri)), {
        issuer,
        audience: clientId,
    });
    assert.equal(verified.payload.nonce, nonce);
    return {
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        refreshToken: tokens.refresh_token,
        neededPassword,
    };
}
const password = process.env.LDAP_ALICE_PASSWORD;
if (!password) throw new Error('LDAP_ALICE_PASSWORD is required');
const first = await authorize('service-desk-test', `${desk}/auth/callback`, password);
assert.equal(first.neededPassword, true);
const second = await authorize(
    'student-service',
    process.env.STUDENT_REDIRECT_URI || 'http://localhost:4300/auth/callback'
);
assert.equal(second.neededPassword, false, 'Both clients share one Identity login');
const headers = { 'content-type': 'application/json', authorization: `Bearer ${second.accessToken}` };
const created = await fetch(`${desk}/rest/servicedeskapi/request`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
        serviceDeskId: '3',
        requestTypeId: '10001',
        requestFieldValues: {
            customfield_12900: 'TRAINING-PC-01',
            customfield_20001: { id: '20002' },
            customfield_20002: { id: '20101' },
            description: 'Сквозная проверка заявки на замену',
        },
    }),
});
assert.equal(created.status, 201, `Create request failed (${created.status}): ${await created.clone().text()}`);
const request = await created.json();
assert.match(request.issueKey, /^HELP-\d+$/);
assert.ok(request.assignee?.name, 'New request is assigned to its active support lead');
assert.ok(request.assignee?.displayName, 'Readable assignee snapshot is returned');
const card = await fetch(`${desk}/rest/servicedeskapi/request/${request.issueKey}`, { headers });
assert.equal(card.status, 200);
assert.equal((await card.json()).requestTypeId, '10001');
const listed = await fetch(`${desk}/rest/servicedeskapi/request?requestStatus=OPEN_REQUESTS&start=0&limit=20`, {
    headers,
});
assert.equal(listed.status, 200, 'Request list is available after sign-in');
const page = await listed.json();
assert.ok(
    page.values.some((item) => item.issueKey === request.issueKey),
    'New request appears in the open list'
);
assert.ok(
    page.values.every((item) => item.reporter.name === 'alice'),
    'Customer list contains only own requests'
);
assert.equal(new URL(page._links.self).searchParams.get('requestStatus'), 'OPEN_REQUESTS');
assert.equal((await fetch(`${desk}/requests`)).status, 200, 'List SPA direct route is served');

if (process.argv.includes('--assignment')) {
    const savedCookies = new Map(cookies);
    cookies.clear();
    let staff;
    try {
        staff = await authorize(
            'service-desk-test',
            `${desk}/auth/callback`,
            process.env.LDAP_SUPPORT_PASSWORD,
            'support'
        );
        const staffHeaders = { 'content-type': 'application/json', authorization: `Bearer ${staff.accessToken}` };
        const uri = `${desk}/rest/api/2/issue/${request.issueKey}/assignee`;
        const candidates = await fetch(
            `${desk}/rest/api/2/user/assignable/search?issueKey=${request.issueKey}&maxResults=100`,
            { headers: staffHeaders }
        );
        assert.equal(candidates.status, 200);
        const users = await candidates.json();
        assert.ok(users.some((entry) => entry.name === 'support'));
        assert.ok(
            !users.some(
                (entry) =>
                    entry.name === 'alice' || entry.name === 'denied' || entry.name.startsWith('service-account-')
            )
        );
        assert.equal(
            (await fetch(uri, { method: 'PUT', headers, body: JSON.stringify({ name: 'support' }) })).status,
            403,
            'Customer cannot distribute requests'
        );
        const change = async (name) =>
            fetch(uri, { method: 'PUT', headers: staffHeaders, body: JSON.stringify({ name }) });
        assert.equal((await change('alice')).status, 400, 'Non-support user is not assignable');
        assert.equal((await change('support')).status, 204);
        let snapshot = await (
            await fetch(`${desk}/rest/servicedeskapi/request/${request.issueKey}`, { headers })
        ).json();
        assert.equal(snapshot.assignee.name, 'support');
        assert.ok(snapshot.assignee.displayName);
        assert.equal((await change(null)).status, 204);
        snapshot = await (await fetch(`${desk}/rest/servicedeskapi/request/${request.issueKey}`, { headers })).json();
        assert.equal(snapshot.assignee, null);
        assert.equal((await change(request.assignee.name)).status, 204, 'Restore initial lead before testing close');
        console.log(
            `Assignment passed: ${request.issueKey}, live Keycloak candidates, reassignment/unassignment, applicant denied.`
        );
    } finally {
        if (staff) {
            const logout = new URL(metadata.end_session_endpoint);
            logout.search = new URLSearchParams({
                id_token_hint: staff.idToken,
                client_id: 'service-desk-test',
                post_logout_redirect_uri: `${desk}/`,
            }).toString();
            assert.equal((await identityRequest(logout)).status, 302);
        }
        cookies.clear();
        for (const [key, value] of savedCookies) cookies.set(key, value);
    }
}
if (process.argv.includes('--close-request')) {
    const url = `${desk}/rest/api/2/issue/${request.issueKey}/transitions`;
    const available = await fetch(`${url}?expand=transitions.fields`, { headers });
    assert.equal(available.status, 200);
    const transitions = (await available.json()).transitions;
    const close = transitions.find((entry) => entry.to.statusCategory.key === 'done');
    assert.ok(close, 'Applicant can close own open request');
    const resolution = close.fields?.resolution?.allowedValues?.[0];
    assert.ok(resolution?.id);
    const payload = { transition: { id: close.id }, fields: { resolution: { id: resolution.id } } };
    const closed = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(closed.status, 204);
    const closedCard = await (
        await fetch(`${desk}/rest/servicedeskapi/request/${request.issueKey}`, { headers })
    ).json();
    assert.equal(closedCard.currentStatus.status, 'Закрыта');
    assert.equal(closedCard.assignee, null, 'Closing removes the primary assignee');
    const closedList = await (
        await fetch(`${desk}/rest/servicedeskapi/request?requestStatus=CLOSED_REQUESTS&limit=20`, { headers })
    ).json();
    assert.ok(closedList.values.some((entry) => entry.issueKey === request.issueKey));
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })).status, 409);
    assert.deepEqual((await (await fetch(url, { headers })).json()).transitions, []);
    console.log(`Applicant close passed: ${request.issueKey}, closed list, repeated close denied.`);
}
const forbidden = await fetch(`${desk}/api/settings`, { headers });
assert.equal(forbidden.status, 403, 'Customer cannot change webhook settings');
console.log(
    `Identity/Service Desk smoke passed: LDAP login, signed OIDC PKCE, SSO across two independent clients, ${request.issueKey}, role boundary.`
);

if (process.argv.includes('--manage-users')) {
    const adminLogin = await fetch(`${idp}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'password',
            client_id: 'admin-cli',
            username: process.env.IDENTITY_ADMIN_USERNAME || 'administrator',
            password: process.env.IDENTITY_ADMIN_PASSWORD,
        }),
    });
    assert.equal(adminLogin.status, 200);
    const adminToken = (await adminLogin.json()).access_token;
    const management = async (path, method = 'GET', body) => {
        const r = await fetch(`${idp}/admin/realms/training${path}`, {
            method,
            headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!r.ok) throw new Error(`Identity management ${method} ${path}: ${r.status} ${await r.text()}`);
        return r;
    };
    const username = `smoke-${randomBytes(5).toString('hex')}`,
        userPassword = randomBytes(24).toString('base64url');
    let userId;
    try {
        const created = await management('/users', 'POST', {
            username,
            enabled: true,
            firstName: 'Smoke',
            lastName: 'Test',
            attributes: { team_slug: ['demo'] },
            credentials: [{ type: 'password', value: userPassword, temporary: false }],
        });
        userId = created.headers.get('location').split('/').at(-1);
        const resource = (await (await management('/clients?clientId=service-desk')).json())[0];
        const customer = await (await management(`/clients/${resource.id}/roles/customer`)).json();
        await management(`/users/${userId}/role-mappings/clients/${resource.id}`, 'POST', [customer]);
        cookies.clear();
        const first = await authorize(
            'student-service',
            process.env.STUDENT_REDIRECT_URI || 'http://localhost:4300/auth/callback',
            userPassword,
            username
        );
        let claims = (
            await jwtVerify(first.accessToken, createRemoteJWKSet(new URL(metadata.jwks_uri)), {
                issuer,
                audience: 'service-desk',
            })
        ).payload;
        assert.equal(claims.preferred_username, username);
        assert.equal(claims.team_slug, 'demo');
        assert.ok(claims.resource_access['service-desk'].roles.includes('customer'));
        const support = await (await management(`/clients/${resource.id}/roles/support`)).json();
        await management(`/users/${userId}/role-mappings/clients/${resource.id}`, 'POST', [support]);
        cookies.clear();
        const changed = await authorize(
            'student-service',
            process.env.STUDENT_REDIRECT_URI || 'http://localhost:4300/auth/callback',
            userPassword,
            username
        );
        claims = (
            await jwtVerify(changed.accessToken, createRemoteJWKSet(new URL(metadata.jwks_uri)), {
                issuer,
                audience: 'service-desk',
            })
        ).payload;
        assert.ok(claims.resource_access['service-desk'].roles.includes('support'));
        assert.equal(
            (
                await fetch(`${desk}/api/settings`, {
                    headers: { authorization: `Bearer ${changed.accessToken}` },
                })
            ).status,
            403,
            'Support cannot read global admin settings'
        );
        const adminRole = await (await management(`/clients/${resource.id}/roles/admin`)).json();
        await management(`/users/${userId}/role-mappings/clients/${resource.id}`, 'POST', [adminRole]);
        cookies.clear();
        const elevated = await authorize(
            'service-desk-swagger',
            `${desk}/docs/static/oauth2-redirect.html`,
            userPassword,
            username
        );
        assert.equal(
            (
                await fetch(`${desk}/api/settings`, {
                    headers: { authorization: `Bearer ${elevated.accessToken}` },
                })
            ).status,
            200,
            'Admin client role enables global settings'
        );
        console.log(
            'Identity user management passed: user/password in LDAP via Keycloak and client-role changes in signed tokens.'
        );
    } finally {
        if (userId) await management(`/users/${userId}`, 'DELETE');
    }
}

if (process.argv.includes('--swagger')) {
    const redirectUri = `${desk}/docs/static/oauth2-redirect.html`;
    const swagger = await authorize('service-desk-swagger', redirectUri);
    assert.equal(swagger.neededPassword, false, 'Swagger continues with the current Identity account');
    const confirmUrl = new URL(metadata.end_session_endpoint);
    confirmUrl.search = new URLSearchParams({
        client_id: 'service-desk-swagger',
        post_logout_redirect_uri: `${desk}/docs/`,
    }).toString();
    const confirmation = await identityRequest(confirmUrl);
    assert.equal(confirmation.status, 200);
    const confirmHtml = await confirmation.text();
    assert.ok(confirmHtml.includes('federation-page'), 'Logout confirmation uses the shared Identity shell');
    assert.ok(!confirmHtml.includes('kc-locale-dropdown'), 'No unstyled inherited locale menu');
    const invalidAuth = new URL(metadata.authorization_endpoint);
    invalidAuth.search = new URLSearchParams({
        client_id: 'service-desk-swagger',
        response_type: 'code',
        redirect_uri: `${desk}/not-registered`,
    }).toString();
    const rejected = await identityRequest(invalidAuth);
    assert.equal(rejected.status, 400);
    const errorHtml = await rejected.text();
    assert.ok(errorHtml.includes('federation-page'), 'Identity errors use the shared shell');
    assert.ok(errorHtml.includes(`href="${desk}/docs/"`), 'Error safely returns to the configured app');
    assert.ok(!errorHtml.includes('kc-locale-dropdown'));
    assert.equal(
        (
            await fetch(`${desk}/api/settings`, {
                headers: { authorization: `Bearer ${swagger.accessToken}` },
            })
        ).status,
        403,
        'Swagger customer is denied support settings'
    );

    async function logout(tokens) {
        const url = new URL(metadata.end_session_endpoint);
        url.search = new URLSearchParams({
            client_id: 'service-desk-swagger',
            id_token_hint: tokens.idToken,
            post_logout_redirect_uri: `${desk}/docs/`,
        }).toString();
        const response = await identityRequest(url);
        assert.equal(response.status, 302, 'Identity ends the SSO session');
        assert.equal(response.headers.get('location'), `${desk}/docs/`);
        const refresh = await fetch(metadata.token_endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: 'service-desk-swagger',
                refresh_token: tokens.refreshToken,
            }),
        });
        assert.equal(refresh.status, 400, 'Ended session cannot refresh tokens');
        const silent = new URL(metadata.authorization_endpoint);
        silent.search = new URLSearchParams({
            client_id: 'service-desk-swagger',
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid',
            prompt: 'none',
            state: 'logout-smoke',
            code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
            code_challenge_method: 'S256',
        }).toString();
        const after = await identityRequest(silent);
        assert.equal(after.status, 302);
        assert.equal(
            new URL(after.headers.get('location')).searchParams.get('error'),
            'login_required',
            'SSO cannot silently sign in after logout'
        );
    }
    await logout(swagger);
    for (const [username, passwordKey, expected] of [
        ['support', 'LDAP_SUPPORT_PASSWORD', 403],
        ['desk-admin', 'DESK_ADMIN_PASSWORD', 200],
        ['denied', 'LDAP_DENIED_PASSWORD', 403],
    ]) {
        const tokens = await authorize('service-desk-swagger', redirectUri, process.env[passwordKey], username, {
            prompt: 'login',
        });
        assert.equal(tokens.neededPassword, true, 'New login required after logout');
        const headers = { authorization: `Bearer ${tokens.accessToken}` };
        assert.equal((await fetch(`${desk}/api/settings`, { headers })).status, expected);
        assert.equal((await fetch(`${desk}/api/settings`, { headers })).status, username === 'desk-admin' ? 200 : 403);
        const me = await fetch(`${desk}/api/me`, { headers });
        assert.equal(me.status, username === 'denied' ? 403 : 200);
        if (me.ok) {
            const principal = await me.json();
            assert.equal(principal.username, username);
            assert.equal(principal.role, username === 'desk-admin' ? 'admin' : 'support');
            assert.ok(principal.teamId);
            assert.equal(
                principal.roleName,
                username === 'desk-admin' ? 'Администратор службы поддержки' : 'Сотрудник поддержки'
            );
        }
        if (username === 'desk-admin') {
            const settingsResponse = await fetch(`${desk}/api/settings`, { headers });
            assert.equal(settingsResponse.status, 200);
            const document = await settingsResponse.json();
            assert.ok(document.server && document.database && document.identity && document.teams);
            assert.equal(document.config, undefined, 'Settings return the JSON document directly');
            const saved = await fetch(`${desk}/api/settings`, {
                method: 'PUT',
                headers: {
                    ...headers,
                    'content-type': 'application/json',
                    'if-match': settingsResponse.headers.get('etag'),
                },
                body: JSON.stringify(document),
            });
            assert.equal(saved.status, 200);
            const updated = await saved.json();
            assert.equal(updated.revision, document.revision + 1);
            assert.deepEqual(
                { ...updated, revision: document.revision },
                document,
                'GET->PUT preserves all configuration values'
            );
            for (const removed of ['/training/settings', '/training/admin/settings', '/training/admin/teams'])
                assert.equal(
                    (await fetch(`${desk}${removed}`, { headers })).status,
                    404,
                    'Old settings/management endpoints removed'
                );
        }
        await logout(tokens);
    }
    console.log(
        'Swagger Identity flow passed: PKCE/SSO, customer/support/admin/denied roles, current principal, RP logout, refresh revoked and silent login denied.'
    );
}
