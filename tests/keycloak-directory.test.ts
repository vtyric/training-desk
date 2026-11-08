import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { KeycloakDirectory, type KeycloakDirectoryConfig } from '../libs/auth';
import { AuthError } from '../libs/auth/types';

type User = {
    id: string;
    username: string;
    enabled: boolean;
    firstName?: string;
    lastName?: string;
    attributes: { team_slug: string[] };
    serviceAccountClientId?: string;
};
const person = (username: string, team = 'demo', enabled = true): User => ({
    id: `id-${username}`,
    username,
    enabled,
    attributes: { team_slug: [team] },
});

async function fixture() {
    const users: User[] = [];
    const roles = new Map<string, string[]>();
    const seen: string[] = [];
    let tokenRequests = 0;
    let tokenLifetime = 300;
    let unauthorized = 0;
    let failure: 'users' | 'token' | 'roles' | 'redirect' | 'malformed' | null = null;
    let delay = 0;
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', 'http://localhost');
        seen.push(url.pathname + url.search);
        const json = (value: unknown, status = 200) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(value));
        };
        if (url.pathname.endsWith('/protocol/openid-connect/token')) {
            let body = '';
            for await (const chunk of req) body += chunk;
            const values = new URLSearchParams(body);
            assert.equal(values.get('grant_type'), 'client_credentials');
            assert.equal(values.get('client_id'), 'service-desk-directory');
            assert.equal(values.get('client_secret'), 'directory-test-secret');
            tokenRequests++;
            if (failure === 'token') return json({ error: 'secret response must never escape' }, 401);
            return json({ access_token: `opaque-${tokenRequests}`, expires_in: tokenLifetime, token_type: 'Bearer' });
        }
        assert.match(req.headers.authorization || '', /^Bearer opaque-\d+$/);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (unauthorized > 0) {
            unauthorized--;
            return json({}, 401);
        }
        if (url.pathname.endsWith('/clients')) {
            assert.equal(url.searchParams.get('clientId'), 'service-desk');
            if (failure === 'redirect') {
                res.writeHead(302, { location: 'http://example.invalid/secret' });
                return res.end();
            }
            return json([{ id: 'resource-id', clientId: 'service-desk' }]);
        }
        if (url.pathname.endsWith('/users')) {
            if (failure === 'users') return json({}, 503);
            if (failure === 'malformed') return json({ not: 'an array' });
            const name = url.searchParams.get('username');
            const matches = name ? users.filter((u) => u.username === name) : users;
            const first = Number(url.searchParams.get('first') || 0);
            const max = Number(url.searchParams.get('max') || 100);
            return json(matches.slice(first, first + max));
        }
        const id = url.pathname.match(/\/users\/([^/]+)/)?.[1];
        const user = users.find((entry) => entry.id === id);
        if (!user) return json({}, 404);
        if (url.pathname.endsWith('/composite')) {
            if (failure === 'roles') return json({}, 403);
            return json((roles.get(user.username) || []).map((name) => ({ name })));
        }
        return json(user);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const config: KeycloakDirectoryConfig = {
        issuerUrl: `http://127.0.0.1:${address.port}/realms/training`,
        resourceClientId: 'service-desk',
        clientId: 'service-desk-directory',
        clientSecret: 'directory-test-secret',
        allowInsecureLocal: true,
    };
    return {
        users,
        roles,
        seen,
        config,
        get tokenRequests() {
            return tokenRequests;
        },
        set lifetime(value: number) {
            tokenLifetime = value;
        },
        set unauthorized(value: number) {
            unauthorized = value;
        },
        set failure(value: typeof failure) {
            failure = value;
        },
        set delay(value: number) {
            delay = value;
        },
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        },
    };
}
const directoryUnavailable = (error: unknown) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.message, 'Не удалось загрузить сотрудников. Повторите попытку позже');
    assert.ok(!JSON.stringify(error).includes('directory-test-secret'));
    return true;
};

test('Directory pages all users and exposes only enabled same-team effective support roles', async () => {
    const f = await fixture();
    try {
        for (let i = 0; i < 98; i++) f.users.push(person(`foreign-${i}`, 'other'));
        f.users.push(
            { ...person('support'), firstName: 'Андрей', lastName: 'Поддержка' },
            person('alice'),
            person('disabled', 'demo', false),
            person('service-account-directory'),
            person('admin')
        );
        f.roles.set('support', ['support']);
        f.roles.set('admin', ['admin']);
        f.roles.set('alice', ['customer']);
        f.roles.set('disabled', ['support']);
        f.roles.set('service-account-directory', ['support']);
        const directory = new KeycloakDirectory(f.config);
        const result = await directory.listEligible('demo');
        assert.deepEqual(result.map((u) => u.username).sort(), ['admin', 'support']);
        assert.equal(result.find((u) => u.username === 'support')?.displayName, 'Андрей Поддержка');
        assert.ok(f.seen.some((url) => url.includes('first=100')));
        assert.equal(f.tokenRequests, 1);
        assert.ok(f.seen.every((url) => !url.includes('directory-test-secret')));
        assert.ok(!f.seen.some((url) => url.includes('id-disabled/role-mappings')));
    } finally {
        await f.close();
    }
});

test('Assignment lookup rereads enabled flag, tenant and effective roles instead of trusting a prior list', async () => {
    const f = await fixture();
    try {
        const user = person('support');
        f.users.push(user);
        f.roles.set('support', ['support']);
        const directory = new KeycloakDirectory(f.config);
        assert.ok(await directory.findEligible('demo', 'support'));
        f.roles.set('support', ['customer']);
        assert.equal(await directory.findEligible('demo', 'support'), null);
        f.roles.set('support', ['admin']);
        user.enabled = false;
        assert.equal(await directory.findEligible('demo', 'support'), null);
        user.enabled = true;
        user.attributes.team_slug = ['other'];
        assert.equal(await directory.findEligible('demo', 'support'), null);
        user.attributes.team_slug = ['demo'];
        assert.ok(await directory.findEligible('demo', 'support'));
        assert.equal(await directory.findEligible('demo', 'missing'), null);
        assert.equal(await directory.findEligible('demo', '../support'), null);
        assert.ok(f.seen.filter((url) => url.endsWith('/users/id-support')).length >= 5);
    } finally {
        await f.close();
    }
});

test('Directory refreshes a rejected or expired service token and retries a 401 only once', async () => {
    const f = await fixture();
    try {
        f.users.push(person('support'));
        f.roles.set('support', ['support']);
        f.unauthorized = 1;
        const directory = new KeycloakDirectory(f.config);
        assert.ok(await directory.findEligible('demo', 'support'));
        assert.equal(f.tokenRequests, 2);
        f.unauthorized = 2;
        await assert.rejects(directory.listEligible('demo'), directoryUnavailable);
        f.unauthorized = 0;
        f.lifetime = 0.001;
        const expiring = new KeycloakDirectory(f.config);
        const before = f.tokenRequests;
        assert.ok(await expiring.findEligible('demo', 'support'));
        assert.ok(f.tokenRequests >= before + 4);
    } finally {
        await f.close();
    }
});

test('Directory errors, malformed data, redirects and timeout fail closed without leaking upstream credentials', async () => {
    const f = await fixture();
    try {
        f.users.push(person('support'));
        f.roles.set('support', ['support']);
        for (const failure of ['token', 'users', 'roles', 'redirect', 'malformed'] as const) {
            f.failure = failure;
            await assert.rejects(new KeycloakDirectory(f.config).listEligible('demo'), directoryUnavailable);
        }
        f.failure = null;
        f.delay = 30;
        await assert.rejects(
            new KeycloakDirectory({ ...f.config, timeoutMs: 5 }).listEligible('demo'),
            directoryUnavailable
        );
    } finally {
        await f.close();
    }
});

test('Directory accepts only trusted realm issuers and cannot silently switch internal realm', () => {
    const config: KeycloakDirectoryConfig = {
        issuerUrl: 'http://example.com/realms/training',
        resourceClientId: 'service-desk',
        clientId: 'service-desk-directory',
        clientSecret: 'directory-test-secret',
        allowInsecureLocal: true,
    };
    assert.throws(() => new KeycloakDirectory(config));
    assert.throws(
        () =>
            new KeycloakDirectory({
                ...config,
                issuerUrl: 'https://identity.example/realms/training',
                internalIssuerUrl: 'http://identity:8080/realms/other',
            })
    );
    assert.throws(() => new KeycloakDirectory({ ...config, issuerUrl: 'https://identity.example/not-a-realm' }));
});

test('Default assignee is the single enabled same-team support lead before any login or prior lookup', async () => {
    const f = await fixture();
    try {
        const lead = { ...person('lead'), firstName: 'Анна', lastName: 'Руководитель' };
        f.users.push(
            lead,
            person('disabled-lead', 'demo', false),
            person('foreign-lead', 'other'),
            person('service-account-lead')
        );
        for (const user of f.users) f.roles.set(user.username, ['support-lead', 'support']);
        const directory = new KeycloakDirectory(f.config);
        assert.deepEqual(await directory.getDefaultAssignee('demo'), {
            username: 'lead',
            displayName: 'Анна Руководитель',
        });
        assert.deepEqual(
            (await directory.listEligible('demo')).map((user) => user.username),
            ['lead']
        );
        // The adapter never keeps candidate/role results between create requests.
        f.roles.set('lead', ['support']);
        await assert.rejects(directory.getDefaultAssignee('demo'), (error: unknown) => {
            assert.ok(error instanceof AuthError);
            assert.equal(error.statusCode, 503);
            assert.match(error.message, /Руководитель поддержки не назначен или отключён/);
            return true;
        });
        f.roles.set('lead', ['support-lead', 'support']);
        lead.enabled = false;
        await assert.rejects(directory.getDefaultAssignee('demo'), { statusCode: 503 });
        lead.enabled = true;
        assert.equal((await directory.getDefaultAssignee('demo')).username, 'lead');
    } finally {
        await f.close();
    }
});

test('No configured lead or multiple leads across directory pages fail instead of selecting somebody else', async () => {
    const f = await fixture();
    try {
        const directory = new KeycloakDirectory(f.config);
        f.users.push(person('ordinary-support'));
        f.roles.set('ordinary-support', ['support']);
        await assert.rejects(directory.getDefaultAssignee('demo'), { statusCode: 503 });
        for (let i = 0; i < 98; i++) f.users.push(person(`foreign-${i}`, 'other'));
        f.users.push(person('lead-one'), person('lead-two'));
        f.roles.set('lead-one', ['support-lead', 'support']);
        f.roles.set('lead-two', ['support-lead', 'support']);
        await assert.rejects(directory.getDefaultAssignee('demo'), (error: unknown) => {
            assert.ok(error instanceof AuthError);
            assert.equal(error.statusCode, 503);
            assert.match(error.message, /несколько руководителей поддержки/);
            return true;
        });
        assert.ok(f.seen.some((url) => url.includes('first=100')));
    } finally {
        await f.close();
    }
});
