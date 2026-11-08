import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/service-desk/src/app';
import { migrateDatabase } from '../apps/service-desk/src/dal/migrate';
import { createSettings, SettingsLogic, registerSettingsRoutes } from '../libs/settings';
import { DeliveryStore } from '../libs/webhooks/dal/store';
import { deliverNext } from '../libs/webhooks/logic/worker';
import { createTestTeam } from './helpers/fixtures';

const original = process.env['DATABASE_URL'];
if (!original) throw new Error('DATABASE_URL is required');
const admin = postgres(original, { max: 1 });
const name = `settings_flow_${randomUUID().replaceAll('-', '')}`;
const url = new URL(original);
url.pathname = `/${name}`;
const adminToken = randomUUID() + randomUUID();
let directory: string;
let app: FastifyInstance;
let settings: Awaited<ReturnType<typeof createSettings>>;
let deliveries: DeliveryStore;
let teamId: string;
let support: string;
let customer: string;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
before(async () => {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    await migrateDatabase(url.href);
    directory = await mkdtemp(join(tmpdir(), 'settings-delivery-'));
    settings = await createSettings('config/backend.json', join(directory, 'backend.json'));
    app = await buildApp({
        databaseUrl: url.href,
        adminToken,
        assigneeDirectory: {
            async getDefaultAssignee(slug) {
                assert.equal(slug, 'flow');
                return { username: 'lead', displayName: 'Руководитель поддержки' };
            },
            async listEligible() {
                return [];
            },
            async findEligible() {
                return null;
            },
        },
        registerFeatures: async (instance, _authenticate, authenticateAdmin) => {
            // Deliberate test adapter: no DNS lookup or external network is performed.
            await registerSettingsRoutes(
                instance,
                new SettingsLogic(settings, async (value) => {
                    assert.equal(new URL(value).protocol, 'https:');
                }),
                authenticateAdmin
            );
        },
    });
    const data = await createTestTeam(app.trainingDb, {
        slug: 'flow',
        name: 'Flow',
        support: 'support',
        customer: 'alice',
    });
    teamId = data.team.id;
    support = data.credentials.supportToken;
    customer = data.credentials.customerToken;
    deliveries = new DeliveryStore(url.href);
    await deliveries.initialize();
});
after(async () => {
    await deliveries?.close();
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
});
async function configure(address: string, enabled = true) {
    const document = await settings.read();
    document.teams[teamId] = {
        webhook: {
            id: teamId,
            url: address,
            enabled,
            createdAt: document.teams[teamId]?.webhook.createdAt ?? new Date().toISOString(),
        },
    };
    const response = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: bearer(adminToken),
        payload: document,
    });
    assert.equal(response.statusCode, 200, response.body);
    const stored = await settings.read();
    assert.equal(stored.teams[teamId].webhook.url, address);
    assert.deepEqual(response.json(), stored);
    await deliveries.projectSettings(stored.teams, () => 'a'.repeat(64));
    return stored.teams[teamId].webhook.id;
}
async function create() {
    const response = await app.inject({
        method: 'POST',
        url: '/rest/servicedeskapi/request',
        headers: bearer(customer),
        payload: {
            serviceDeskId: '3',
            requestTypeId: '10001',
            requestFieldValues: {
                customfield_12900: 'TEST-PC',
                customfield_20001: { id: '20002' },
                customfield_20002: { id: '20101' },
                description: 'Нужна замена',
            },
        },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().issueKey as string;
}
test('Service Desk settings REST persists JSON and switches the actual primary webhook destination', async () => {
    assert.equal((await app.inject({ url: '/api/settings', headers: bearer(customer) })).statusCode, 403);
    const id = await configure('https://student-one.example/webhooks/jira');
    const first = await create();
    await deliveries.prepare();
    const sent: { url: string; key: string }[] = [];
    const sender = async (address: string, _secret: string, _eventId: string, payload: string) => {
        const event = JSON.parse(payload);
        assert.equal(event.webhookEvent, 'jira:issue_created');
        assert.equal(event.issue.fields.customfield_10201.requestType.id, '10001');
        sent.push({ url: address, key: event.issue.key });
        return 204;
    };
    assert.ok(await deliverNext(deliveries, sender));
    assert.deepEqual(sent[0], { url: 'https://student-one.example/webhooks/jira', key: first });
    assert.equal(await configure('https://student-two.example/rest/created'), id);
    const second = await create();
    await deliveries.prepare();
    assert.ok(await deliverNext(deliveries, sender));
    assert.deepEqual(sent[1], { url: 'https://student-two.example/rest/created', key: second });
    await configure('', false);
    await create();
    await deliveries.prepare();
    assert.equal(await deliverNext(deliveries, sender), false);
    assert.equal(sent.length, 2);
    await configure('https://student-two.example/rest/created');
    const deleted = await settings.read();
    delete deleted.teams[teamId];
    const removal = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: bearer(adminToken),
        payload: deleted,
    });
    assert.equal(removal.statusCode, 200, removal.body);
    await deliveries.projectSettings((await settings.read()).teams, () => 'a'.repeat(64));
    await create();
    await deliveries.prepare();
    assert.equal(await deliverNext(deliveries, sender), false, 'Removing callback from JSON stops future deliveries');
    const history = await deliveries.list(teamId);
    assert.equal(history.length, 2, 'Previously delivered records remain available');
});
test('global operational settings require admin and expose references instead of environment secrets', async () => {
    assert.equal((await app.inject({ url: '/api/settings', headers: bearer(support) })).statusCode, 403);
    const response = await app.inject({ url: '/api/settings', headers: bearer(adminToken) });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().database.urlEnv, 'DATABASE_URL');
    assert.ok(!response.body.includes(original!));
    const config = response.json();
    config.webhooks.batchSize = 10;
    const saved = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        headers: { ...bearer(adminToken), 'if-match': response.headers['etag'] as string },
        payload: config,
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.headers['x-restart-required'], 'true');
    assert.equal(settings.getActiveConfig().webhooks.batchSize, 20);
});
