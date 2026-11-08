import assert from 'node:assert/strict';
import { test } from 'node:test';
import fastify from 'fastify';
import { registerIdentityRoutes } from '../apps/service-desk/src/api/identity-routes';
import { registerRoutes } from '../apps/service-desk/src/api/routes';
import { registerSettingsRoutes } from '../libs/settings/api/routes';
import type { RequestLogic } from '../apps/service-desk/src/logic/requests';
import type { SettingsLogic } from '../libs/settings/logic/settings-logic';
import { identityLogoutPlugin, registerSwagger } from '../apps/service-desk/src/api/swagger';

test('Swagger publishes PKCE OAuth and public callback without a database', async () => {
    const app = fastify();
    await registerSwagger(app, 'Test', 'http://localhost:8081/realms/training');
    app.get('/protected', async () => ({ ok: true }));
    await app.ready();
    try {
        const response = await app.inject('/docs/json');
        assert.equal(response.statusCode, 200, response.body);
        const spec = response.json();
        assert.equal(
            spec.components.securitySchemes.identityOAuth.flows.authorizationCode.tokenUrl,
            'http://localhost:8081/realms/training/protocol/openid-connect/token'
        );
        assert.deepEqual(spec.security, [{ identityOAuth: [] }]);
        const initializer = await app.inject('/docs/static/swagger-initializer.js');
        assert.equal(initializer.statusCode, 200);
        assert.match(initializer.body, /"usePkceWithAuthorizationCodeGrant":true/);
        assert.match(initializer.body, /"persistAuthorization":false/);
        assert.match(initializer.body, /identityLogoutPlugin/);
        assert.doesNotMatch(initializer.body, /"prompt":"login"/);
        assert.equal((await app.inject('/docs/static/oauth2-redirect.html')).statusCode, 200);
    } finally {
        await app.close();
    }
});

test('OAuth logout clears authorization before ending Identity session; bearer logout stays local', () => {
    let cleared = false;
    let destination = '';
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: {
            origin: 'http://localhost:3000',
            assign: (url: string) => {
                assert.equal(cleared, true);
                destination = url;
            },
        },
    });
    try {
        const plugin = identityLogoutPlugin({
            getConfigs: () => ({
                identityLogoutUrl: 'http://localhost:8081/realms/training/protocol/openid-connect/logout',
            }),
            authSelectors: { authorized: () => ({ getIn: () => 'test-id-token' }) },
        });
        const logout = plugin.statePlugins.auth.wrapActions.logout(() => {
            cleared = true;
        });
        logout(['bearerAuth']);
        assert.equal(destination, '');
        cleared = false;
        logout(['identityOAuth']);
        const url = new URL(destination);
        assert.equal(url.searchParams.get('id_token_hint'), 'test-id-token');
        assert.equal(url.searchParams.get('client_id'), 'service-desk-swagger');
        assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'http://localhost:3000/docs/');
    } finally {
        if (previous) Object.defineProperty(globalThis, 'location', previous);
        else Reflect.deleteProperty(globalThis, 'location');
    }
});

test('All real API routes have groups and role guidance; static UI routes stay out of Swagger', async () => {
    const app = fastify();
    const authenticate = async () => ({ username: 'alice', role: 'customer' as const, teamId: 'team-a' });
    const authenticateAdmin = async () => {};
    await registerSwagger(app, 'Test', 'http://localhost:8081/realms/training');
    await registerIdentityRoutes(app, authenticate);
    // Generating route documentation must not touch a database or invoke business logic.
    await registerRoutes(app, {} as RequestLogic, authenticate);
    await registerSettingsRoutes(app, {} as SettingsLogic, authenticateAdmin);
    app.get('/health', { schema: { security: [] } }, async () => ({ status: 'ok' }));
    app.get('/api/config', { schema: { security: [] } }, async () => ({}));
    app.get('/requests/:key', async () => 'SPA');
    app.get('/auth/callback', async () => 'SPA');
    try {
        const response = await app.inject('/docs/json');
        assert.equal(response.statusCode, 200, response.body);
        const spec = response.json();
        const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
        let count = 0;
        for (const [path, item] of Object.entries(spec.paths)) {
            for (const [method, operation] of Object.entries(
                item as Record<
                    string,
                    {
                        tags?: string[];
                        summary?: string;
                        description?: string;
                        responses: Record<string, unknown>;
                    }
                >
            )) {
                if (!methods.has(method)) continue;
                count++;
                assert.equal(operation.tags?.length, 1, `${method} ${path} has one group`);
                assert.notEqual(operation.tags?.[0], 'default');
                assert.ok(operation.summary, `${method} ${path} has a summary`);
                assert.match(operation.description || '', /Доступ|Публичный/, `${method} ${path} explains access`);
                if (path !== '/health' && path !== '/api/config') {
                    assert.ok(operation.responses['401'], `${method} ${path} documents missing token`);
                    assert.ok(operation.responses['403'], `${method} ${path} documents access denial`);
                }
            }
        }
        assert.equal(count, 14);
        assert.equal(spec.paths['/requests/{key}'], undefined);
        assert.equal(spec.paths['/auth/callback'], undefined);
        assert.equal(spec.paths['/health'], undefined);
        assert.equal(spec.paths['/api/config'], undefined);
        assert.ok(spec.paths['/rest/servicedeskapi/request'].post.responses['201']);
        assert.ok(spec.paths['/api/settings'].put.responses['200']);
        assert.deepEqual(
            Object.keys(spec.paths['/api/settings'])
                .filter((key) => methods.has(key))
                .sort(),
            ['get', 'patch', 'put']
        );
        assert.ok(!Object.keys(spec.paths).some((path) => path.startsWith('/training/')));
        assert.ok(spec.paths['/rest/api/2/issue/{key}/assignee'].put.responses['204']);
        assert.equal(spec.paths['/rest/api/2/search'], undefined);
        assert.equal(spec.paths['/rest/api/2/issue/{key}'], undefined);
        assert.equal(spec.paths['/rest/servicedeskapi/servicedesk/{deskId}/queue'], undefined);
        assert.ok(spec.paths['/rest/servicedeskapi/request'].get);
        assert.match(spec.paths['/rest/servicedeskapi/request'].get.description, /OPEN_REQUESTS/);
        assert.ok(spec.paths['/rest/api/2/issue/{key}/transitions'].post.responses['204']);
        assert.match(spec.paths['/api/settings'].get.description, /администратор службы поддержки/);
        assert.match(spec.paths['/rest/servicedeskapi/request/{key}/comment'].post.description, /public=true/);
    } finally {
        await app.close();
    }
});

test('Current-user endpoint authenticates on every request and returns only the verified principal', async () => {
    const app = fastify();
    let authenticated = 0;
    await registerIdentityRoutes(app, async (request) => {
        authenticated++;
        if (request.headers.authorization !== 'Bearer verified')
            throw Object.assign(new Error('Missing token'), { statusCode: 401 });
        return { username: 'support', role: 'support', teamId: 'team-a' };
    });
    try {
        assert.equal((await app.inject('/api/me?username=admin&role=admin')).statusCode, 401);
        const response = await app.inject({
            url: '/api/me?role=admin',
            headers: { authorization: 'Bearer verified' },
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), {
            username: 'support',
            role: 'support',
            roleName: 'Сотрудник поддержки',
            teamId: 'team-a',
        });
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(authenticated, 2);
    } finally {
        await app.close();
    }
});
