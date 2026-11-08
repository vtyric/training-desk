import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { URLSearchParams } from 'node:url';
import assert from 'node:assert/strict';
import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
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

// Real remote integration: explicit opt-in because this creates and closes a request.
assert.ok(process.argv.includes('--apply'), 'Use --apply to create a request on the configured training desk');
assert.ok(process.env.STUDENT_WEBHOOK_URL && process.env.STUDENT_WEBHOOK_SECRET);
const events = [];
const seen = new Set();
const receiver = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/webhooks/service-desk') {
        response.writeHead(404).end();
        return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const actual = Buffer.from(String(request.headers['x-training-signature'] ?? ''));
    const expected = Buffer.from(
        'sha256=' + createHmac('sha256', process.env.STUDENT_WEBHOOK_SECRET).update(raw).digest('hex')
    );
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(401).end();
        return;
    }
    const eventId = request.headers['x-training-event-id'];
    if (typeof eventId !== 'string') {
        response.writeHead(400).end();
        return;
    }
    if (!seen.has(eventId)) {
        seen.add(eventId);
        events.push({ ...JSON.parse(raw), eventId });
    }
    response.writeHead(204).end();
});
const proxy = createServer(async (request, response) => {
    if (!request.url?.startsWith('/desk-api/')) {
        response.writeHead(404).end();
        return;
    }
    try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const data = Buffer.concat(chunks);
        const headers = {};
        for (const name of ['authorization', 'content-type', 'if-match'])
            if (request.headers[name]) headers[name] = request.headers[name];
        const upstream = await fetch(desk + request.url.slice('/desk-api'.length), {
            method: request.method,
            headers,
            ...(data.length ? { body: data } : {}),
            redirect: 'manual',
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        response.writeHead(
            upstream.status,
            Object.fromEntries(
                ['content-type', 'etag', 'x-restart-required']
                    .filter((h) => upstream.headers.has(h))
                    .map((h) => [h, upstream.headers.get(h)])
            )
        );
        response.end(bytes);
    } catch {
        response.writeHead(502).end();
    }
});
const local = 'http://localhost:4300/desk-api';
const call = (token, path, method = 'GET', body, extra = {}) =>
    fetch(local + path, {
        method,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...extra,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
const signIn = async (username, password) => {
    cookies.clear();
    return authorize(
        'student-service',
        process.env.STUDENT_REDIRECT_URI || 'http://localhost:4300/auth/callback',
        password,
        username
    );
};
const waitEvent = async (key, test) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const event = events.find((e) => e.issue?.key === key && test(e));
        if (event) return event;
        await delay(500);
    }
    throw new Error(`Signed webhook not received for ${key}`);
};
receiver.listen(4310, '0.0.0.0');
await once(receiver, 'listening');
proxy.listen(4300, '127.0.0.1');
await once(proxy, 'listening');
try {
    assert.equal((await call(null, '/api/me')).status, 401);
    const customer = await signIn('alice', process.env.LDAP_ALICE_PASSWORD);
    const support = await signIn('support', process.env.LDAP_SUPPORT_PASSWORD);
    const admin = await signIn('desk-admin', process.env.DESK_ADMIN_PASSWORD);
    assert.equal((await call(customer.accessToken, '/api/settings')).status, 403);
    assert.equal((await call(support.accessToken, '/api/settings')).status, 403);
    const me = await (await call(admin.accessToken, '/api/me')).json();
    assert.equal(me.role, 'admin');
    const settingsResponse = await call(admin.accessToken, '/api/settings');
    assert.equal(settingsResponse.status, 200);
    const settings = await settingsResponse.json();
    const existing = settings.teams[me.teamId]?.webhook;
    const webhook = existing
        ? { url: process.env.STUDENT_WEBHOOK_URL, enabled: true }
        : { id: me.teamId, url: process.env.STUDENT_WEBHOOK_URL, enabled: true, createdAt: new Date().toISOString() };
    const changed = await call(
        admin.accessToken,
        '/api/settings',
        'PATCH',
        { teams: { [me.teamId]: { webhook } } },
        { 'if-match': settingsResponse.headers.get('etag') }
    );
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.equal(changed.headers.get('x-restart-required'), 'false');
    console.log('PASS: localhost proxy, authenticated API, 401/403, admin PATCH with ETag');
    assert.equal(
        (await call(customer.accessToken, '/rest/servicedeskapi/servicedesk/3/requesttype/10001/field')).status,
        200
    );
    const created = await call(customer.accessToken, '/rest/servicedeskapi/request', 'POST', {
        serviceDeskId: '3',
        requestTypeId: '10001',
        requestFieldValues: {
            customfield_12900: 'STUDENT-INTEGRATION-CHECK',
            customfield_20001: { id: '20002' },
            customfield_20002: { id: '20101' },
            description: 'Проверка инструкции: localhost, webhook, исполнитель, статусы и закрытие.',
        },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const item = await created.json();
    const key = item.issueKey;
    assert.equal(item.assignee.name, 'support-lead');
    await waitEvent(key, (e) => e.webhookEvent === 'jira:issue_created' || e.event === 'jira:issue_created');
    console.log('PASS: created', key, 'assigned to support-lead; signed webhook received on localhost');
    const list = await (await call(support.accessToken, '/rest/servicedeskapi/request?limit=25')).json();
    assert.ok(list.values.some((e) => e.issueKey === key));
    const candidates = await (
        await call(support.accessToken, '/rest/api/2/user/assignable/search?project=HELP&username=support')
    ).json();
    assert.ok(candidates.some((e) => e.name === 'support'));
    const assignment = `/rest/api/2/issue/${key}/assignee`;
    assert.equal((await call(customer.accessToken, assignment, 'PUT', { name: 'support' })).status, 403);
    assert.equal((await call(support.accessToken, assignment, 'PUT', { name: 'support' })).status, 204);
    const comments = `/rest/servicedeskapi/request/${key}/comment`;
    assert.equal(
        (await call(support.accessToken, comments, 'POST', { body: 'Приняли обращение в работу.', public: true }))
            .status,
        201
    );
    assert.equal(
        (await call(support.accessToken, comments, 'POST', { body: 'Внутренняя проверка инструкции.', public: false }))
            .status,
        201
    );
    const visible = await (await call(customer.accessToken, comments)).json();
    assert.ok(visible.values.some((e) => e.body === 'Приняли обращение в работу.'));
    assert.ok(!visible.values.some((e) => e.body === 'Внутренняя проверка инструкции.'));
    const transitions = `/rest/api/2/issue/${key}/transitions`;
    for (const id of ['10006', '10008']) {
        const options = await (await call(support.accessToken, transitions + '?expand=transitions.fields')).json();
        assert.ok(options.transitions.some((e) => e.id === id));
        assert.equal((await call(support.accessToken, transitions, 'POST', { transition: { id } })).status, 204);
    }
    const closeOptions = await (await call(customer.accessToken, transitions + '?expand=transitions.fields')).json();
    assert.ok(closeOptions.transitions.some((e) => e.id === '10011'));
    assert.equal(
        (
            await call(customer.accessToken, transitions, 'POST', {
                transition: { id: '10011' },
                fields: { resolution: { id: '10100' } },
            })
        ).status,
        204
    );
    const card = await (await call(customer.accessToken, `/rest/servicedeskapi/request/${key}`)).json();
    assert.equal(card.assignee, null);
    await waitEvent(
        key,
        (e) =>
            (e.webhookEvent === 'jira:issue_updated' || e.event === 'jira:issue_updated') &&
            e.issue?.fields?.assignee === null
    );
    console.log(
        'PASS: assignment, comments visibility, transitions, customer close, assignee cleared, signed update received'
    );
    const refresh = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: 'student-service',
            refresh_token: customer.refreshToken,
        }),
    });
    assert.equal(refresh.status, 200);
    const fresh = await refresh.json();
    const logout = await identityRequest(metadata.end_session_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: 'student-service', refresh_token: fresh.refresh_token }),
    });
    assert.ok([200, 204, 302].includes(logout.status));
    const refreshAfter = await fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: 'student-service',
            refresh_token: fresh.refresh_token,
        }),
    });
    assert.equal(refreshAfter.status, 400);
    console.log('PASS: refresh works before logout and fails after logout');
    console.log(
        JSON.stringify({
            issueKey: key,
            signedEvents: events.filter((e) => e.issue?.key === key).length,
            settingsRevision: (await changed.json()).revision,
        })
    );
} finally {
    await Promise.all([
        new Promise((resolve) => receiver.close(resolve)),
        new Promise((resolve) => proxy.close(resolve)),
    ]);
}
