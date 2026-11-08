import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import Fastify, { type FastifyError } from 'fastify';
import { createSettings, registerSettingsRoutes, SettingsError, SettingsLogic, type SettingsDocument } from './index';

const teamA = '11111111-1111-4111-8111-111111111111';
const defaultFile = join(process.cwd(), 'config/backend.json');
const validateUrl = async (url: string) => {
    if (!url.startsWith('https://receiver.example/')) throw new Error('Unsafe URL');
};
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'service-desk-settings-'));
    const state = join(directory, 'state/backend.json');
    const store = await createSettings(defaultFile, state);
    return {
        directory,
        state,
        store,
        logic: new SettingsLogic(store, validateUrl),
        cleanup: () => rm(directory, { recursive: true, force: true }),
    };
}
function callback(document: SettingsDocument, url: string, enabled = true) {
    document.teams[teamA] = { webhook: { id: teamA, url, enabled, createdAt: '2026-01-01T00:00:00.000Z' } };
    return document;
}

test('complete JSON round trips persist all settings, and only operational changes need restart', async () => {
    const f = await fixture();
    const defaults = await readFile(defaultFile, 'utf8');
    try {
        const original = await f.logic.get();
        assert.deepEqual(original, JSON.parse(await readFile(f.state, 'utf8')));
        const withCallback = await f.logic.put(callback(structuredClone(original), 'https://receiver.example/hook'));
        assert.equal(f.logic.restartRequired(withCallback), false);
        const desired = structuredClone(withCallback);
        desired.server.port += 1;
        const saved = await f.logic.put(desired);
        assert.equal(saved.revision, 2);
        assert.equal(f.logic.restartRequired(saved), true);
        assert.equal(f.store.getActiveConfig().server.port, original.server.port);
        const reopened = await createSettings(defaultFile, f.state);
        const restored = new SettingsLogic(reopened, validateUrl);
        assert.deepEqual(await restored.get(), saved);
        assert.equal(restored.restartRequired(saved), false);
        assert.equal(await readFile(defaultFile, 'utf8'), defaults);
        assert.equal((await stat(f.state)).mode & 0o777, 0o600);
    } finally {
        await f.cleanup();
    }
});

test('all receiver URLs are validated before saving and existing subscription identity is stable', async () => {
    const f = await fixture();
    try {
        await assert.rejects(f.logic.put(callback(await f.logic.get(), 'https://private.example/hook')), {
            statusCode: 400,
        });
        assert.equal((await f.logic.get()).revision, 0);
        const first = await f.logic.put(callback(await f.logic.get(), 'https://receiver.example/hook'));
        const changed = structuredClone(first);
        changed.teams[teamA].webhook.url = 'https://receiver.example/changed';
        changed.teams[teamA].webhook.createdAt = '2026-02-02T00:00:00.000Z';
        const next = await f.logic.put(changed);
        assert.equal(next.teams[teamA].webhook.id, first.teams[teamA].webhook.id);
        assert.equal(next.teams[teamA].webhook.createdAt, first.teams[teamA].webhook.createdAt);
        const offline = new SettingsLogic(f.store, async () => {
            throw new Error('DNS unavailable');
        });
        next.teams[teamA].webhook.enabled = false;
        await offline.put(next);
        assert.equal((await f.logic.get()).teams[teamA].webhook.enabled, false);
    } finally {
        await f.cleanup();
    }
});

test('body revision serializes competing complete-document writes and rejects stale/mismatched revisions', async () => {
    const f = await fixture();
    try {
        const one = await f.logic.get();
        const two = structuredClone(one);
        one.service.name = 'First';
        two.service.name = 'Second';
        const results = await Promise.allSettled([f.logic.put(one), f.logic.put(two)]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const rejected = results.find((r) => r.status === 'rejected');
        assert.ok(rejected?.status === 'rejected' && rejected.reason.statusCode === 409);
        assert.equal((await f.logic.get()).revision, 1);
        await assert.rejects(f.logic.put(await f.logic.get(), 999), { statusCode: 400 });
        assert.deepEqual(await f.logic.get(), JSON.parse(await readFile(f.state, 'utf8')));
    } finally {
        await f.cleanup();
    }
});

test('strict complete-document schema rejects secrets, arbitrary ENV references and corrupt state', async () => {
    const f = await fixture();
    try {
        const original = await f.logic.get();
        for (const invalid of [
            { ...original, database: { ...original.database, password: 'must-not-save' } },
            { ...original, database: { ...original.database, urlEnv: 'ADMIN_TOKEN' } },
            { ...original, identity: { ...original.identity, issuerUrlEnv: 'ADMIN_TOKEN' } },
            { ...original, identity: { ...original.identity, directoryClientSecretEnv: 'ADMIN_TOKEN' } },
            { ...original, ui: { ...original.ui, identityUrlEnv: 'ADMIN_TOKEN' } },
            { config: original },
        ])
            await assert.rejects(f.logic.put(invalid), { statusCode: 400 });
        assert.equal((await f.logic.get()).revision, 0);
        await writeFile(f.state, '{invalid-json');
        await assert.rejects(createSettings(defaultFile, f.state), SyntaxError);
        assert.equal(await readFile(f.state, 'utf8'), '{invalid-json');
    } finally {
        await f.cleanup();
    }
});

test('GET/PUT /api/settings expose one full document, require administrator and preserve ETag/restart headers', async () => {
    const f = await fixture();
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof SettingsError)
            return reply.code(error.statusCode).send({ errorMessages: [error.message] });
        throw error;
    });
    await registerSettingsRoutes(app, f.logic, async (request) => {
        if (!request.headers.authorization) throw new SettingsError(401, 'Требуется вход');
        if (request.headers.authorization !== 'Bearer admin')
            throw new SettingsError(403, 'Требуется администратор Service Desk');
    });
    const headers = { authorization: 'Bearer admin' };
    try {
        assert.equal((await app.inject('/api/settings')).statusCode, 401);
        for (const role of ['customer', 'support']) {
            assert.equal(
                (await app.inject({ url: '/api/settings', headers: { authorization: `Bearer ${role}` } })).statusCode,
                403
            );
            assert.equal(
                (
                    await app.inject({
                        method: 'PUT',
                        url: '/api/settings',
                        headers: { authorization: `Bearer ${role}` },
                        payload: await f.logic.get(),
                    })
                ).statusCode,
                403
            );
        }
        const before = await app.inject({ url: '/api/settings', headers });
        assert.equal(before.statusCode, 200);
        assert.equal(before.headers.etag, '"0"');
        assert.deepEqual(before.json(), await f.logic.get());
        const changed = before.json<SettingsDocument>();
        changed.server.port += 1;
        const saved = await app.inject({
            method: 'PUT',
            url: '/api/settings',
            headers: { ...headers, 'if-match': '"0"' },
            payload: changed,
        });
        assert.equal(saved.statusCode, 200, saved.body);
        assert.equal(saved.headers.etag, '"1"');
        assert.equal(saved.headers['x-restart-required'], 'true');
        assert.equal(saved.json().server.port, changed.server.port);
        assert.ok(!('config' in saved.json()));
        const stale = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: changed });
        assert.equal(stale.statusCode, 409);
        const mismatch = await app.inject({
            method: 'PUT',
            url: '/api/settings',
            headers: { ...headers, 'if-match': '"99"' },
            payload: saved.json(),
        });
        assert.equal(mismatch.statusCode, 400);
        assert.equal((await app.inject('/training/settings')).statusCode, 404);
        assert.equal((await app.inject('/training/admin/settings')).statusCode, 404);
    } finally {
        await app.close();
        await f.cleanup();
    }
});

test('PATCH merges current nested fields, replaces arrays and preserves disjoint concurrent changes', async () => {
    const f = await fixture();
    try {
        const original = await f.logic.get();
        const patched = await f.logic.patch({
            server: { port: original.server.port + 1 },
            webhooks: { retryDelaysMs: [100, 200] },
        });
        assert.equal(patched.server.port, original.server.port + 1);
        assert.equal(patched.server.host, original.server.host);
        assert.deepEqual(patched.identity, original.identity);
        assert.deepEqual(patched.webhooks.retryDelaysMs, [100, 200]);
        assert.equal(patched.webhooks.batchSize, original.webhooks.batchSize);
        await Promise.all([
            f.logic.patch({ server: { bodyLimit: original.server.bodyLimit + 1 } }),
            f.logic.patch({ service: { name: 'Изменённый Service Desk' } }),
        ]);
        const after = await f.logic.get();
        assert.equal(after.server.bodyLimit, original.server.bodyLimit + 1);
        assert.equal(after.service.name, 'Изменённый Service Desk');
        assert.equal(after.revision, 3);
        const revisions = await Promise.allSettled([
            f.logic.patch({ service: { name: 'One' } }, 3),
            f.logic.patch({ service: { name: 'Two' } }, 3),
        ]);
        assert.equal(revisions.filter((result) => result.status === 'fulfilled').length, 1);
        const rejected = revisions.find((result) => result.status === 'rejected');
        assert.ok(rejected?.status === 'rejected' && rejected.reason.statusCode === 409);
        assert.equal((await f.logic.get()).revision, 4);
    } finally {
        await f.cleanup();
    }
});

test('PATCH validates full merged settings, callback URLs and rejects unsafe keys without writes', async () => {
    const f = await fixture();
    try {
        const initial = await f.logic.put(callback(await f.logic.get(), 'https://receiver.example/original'));
        for (const input of [
            {},
            [],
            null,
            'value',
            { version: 1 },
            { revision: 1 },
            { server: { unknown: 1 } },
            { unknown: { anything: 1 } },
            { server: { port: null } },
            { database: { urlEnv: 'ADMIN_TOKEN' } },
            { identity: { directoryClientSecretEnv: 'ADMIN_TOKEN' } },
            { webhooks: { retryDelaysMs: [null] } },
            JSON.parse('{"server":{"__proto__":{"polluted":true}}}'),
            JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
            { teams: { [teamA]: { webhook: { url: 'https://private.example/hook' } } } },
        ]) {
            await assert.rejects(f.logic.patch(input), { statusCode: 400 });
            assert.deepEqual(await f.logic.get(), initial);
        }
        const saved = await f.logic.patch({ teams: { [teamA]: { webhook: { url: 'https://receiver.example/new' } } } });
        assert.equal(saved.teams[teamA].webhook.url, 'https://receiver.example/new');
        assert.equal(saved.teams[teamA].webhook.id, initial.teams[teamA].webhook.id);
        assert.equal(saved.teams[teamA].webhook.createdAt, initial.teams[teamA].webhook.createdAt);
        const offline = new SettingsLogic(f.store, async () => {
            throw new Error('DNS unavailable');
        });
        const disabled = await offline.patch({ teams: { [teamA]: { webhook: { enabled: false } } } });
        assert.equal(disabled.teams[teamA].webhook.enabled, false);
        assert.equal(disabled.teams[teamA].webhook.url, saved.teams[teamA].webhook.url);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
    } finally {
        await f.cleanup();
    }
});

test('PATCH HTTP requires administrator before parsing, returns complete JSON and honors If-Match', async () => {
    const f = await fixture();
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    app.setErrorHandler((error, _request, reply) => {
        if (error instanceof SettingsError)
            return reply.code(error.statusCode).send({ errorMessages: [error.message] });
        const failure = error as FastifyError;
        return reply.code(failure.statusCode ?? 500).send({ message: failure.message });
    });
    await registerSettingsRoutes(app, f.logic, async (request) => {
        if (!request.headers.authorization) throw new SettingsError(401, 'Требуется вход');
        if (request.headers.authorization !== 'Bearer admin') throw new SettingsError(403, 'Требуется администратор');
    });
    const headers = { authorization: 'Bearer admin' };
    try {
        assert.equal(
            (await app.inject({ method: 'PATCH', url: '/api/settings', payload: { server: { port: 3100 } } }))
                .statusCode,
            401
        );
        assert.equal(
            (
                await app.inject({
                    method: 'PATCH',
                    url: '/api/settings',
                    headers: { authorization: 'Bearer customer' },
                    payload: 'invalid',
                })
            ).statusCode,
            403
        );
        const saved = await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { ...headers, 'if-match': '"0"' },
            payload: { server: { port: 3100 } },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        assert.equal(saved.headers.etag, '"1"');
        assert.equal(saved.headers['x-restart-required'], 'true');
        assert.deepEqual(saved.json(), await f.logic.get());
        assert.equal(saved.json().server.port, 3100);
        for (const payload of [
            { version: 1 },
            { revision: 1 },
            { server: { unknown: 1 } },
            { server: { port: null } },
            {},
        ])
            assert.equal(
                (await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload })).statusCode,
                400
            );
        const stale = await app.inject({
            method: 'PATCH',
            url: '/api/settings',
            headers: { ...headers, 'if-match': '"0"' },
            payload: { server: { port: 3200 } },
        });
        assert.equal(stale.statusCode, 409);
        const roundtrip = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: saved.json() });
        assert.equal(roundtrip.statusCode, 200, roundtrip.body);
        assert.equal(roundtrip.json().server.port, 3100);
    } finally {
        await app.close();
        await f.cleanup();
    }
});
