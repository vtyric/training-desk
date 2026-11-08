import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { eq, asc } from 'drizzle-orm';
import { createTestTeam } from './helpers/fixtures';
import { subscriptions, teams, issues, history, outbox, apiTokens, users } from '../apps/service-desk/src/dal/schema';
import { hashToken, Repository } from '../apps/service-desk/src/dal/repository';
import { buildApp } from '../apps/service-desk/src/app';
import { migrateDatabase } from '../apps/service-desk/src/dal/migrate';
import { DeliveryStore } from '../libs/webhooks/dal/store';
import { deliverNext } from '../libs/webhooks/logic/worker';
import { isPublicAddress, resolveDestination } from '../libs/webhooks/dal/destination';

const masterUrl = process.env['DATABASE_URL'];
if (!masterUrl) throw new Error('Run pnpm setup:env and pnpm infra:start before integration tests');
const master = postgres(masterUrl, { max: 1 });
const dbName = `training_test_${randomUUID().replaceAll('-', '')}`;
const testUrl = new URL(masterUrl);
testUrl.pathname = `/${dbName}`;
const adminToken = randomUUID() + randomUUID();
let app: FastifyInstance;
let customer: string;
let support: string;
let foreign: string;
let anotherCustomer: string;
let serviceAdmin: string;
let teamId: string;
let key: string;
let store: DeliveryStore;
const authorization = (token: string) => ({ authorization: `Bearer ${token}` });
let directoryUnavailable = false;
let newSupportEnabled = true;
let defaultLeadMode: 'ready' | 'missing' | 'ambiguous' = 'ready';
const directory = {
    async getDefaultAssignee(slug: string) {
        if (directoryUnavailable || defaultLeadMode !== 'ready')
            throw new Error('Default lead is unavailable: ' + defaultLeadMode);
        return { username: slug === 'test' ? 'lead' : 'other-lead', displayName: 'Руководитель поддержки' };
    },
    async listEligible(slug: string) {
        if (directoryUnavailable) throw new Error('Identity connection failed');
        if (slug !== 'test') return [{ username: 'support2', displayName: 'Другая поддержка' }];
        return [
            { username: 'support', displayName: 'Сотрудник поддержки' },
            { username: 'desk-admin', displayName: 'Администратор' },
            { username: 'lead', displayName: 'Руководитель поддержки' },
            ...(newSupportEnabled ? [{ username: 'new-support', displayName: 'Новый сотрудник' }] : []),
        ];
    },
    async findEligible(slug: string, username: string) {
        return (await this.listEligible(slug)).find((user) => user.username === username) ?? null;
    },
};

before(async () => {
    await master.unsafe(`CREATE DATABASE "${dbName}"`);
    await migrateDatabase(testUrl.href);
    app = await buildApp({
        databaseUrl: testUrl.href,
        adminToken,
        baseUrl: 'https://training.example',
        assigneeDirectory: directory,
    });
    const data = await createTestTeam(app.trainingDb, {
        slug: 'test',
        name: 'Test',
        support: 'support',
        customer: 'alice',
    });
    customer = data.credentials.customerToken;
    support = data.credentials.supportToken;
    teamId = data.team.id;
    anotherCustomer = randomUUID();
    serviceAdmin = randomUUID();
    await app.trainingDb
        .insert(apiTokens)
        .values({ teamId, username: 'desk-admin', role: 'admin', hash: hashToken(serviceAdmin) });
    await app.trainingDb.insert(apiTokens).values({
        teamId,
        username: 'eve',
        role: 'customer',
        hash: hashToken(anotherCustomer),
    });
    const other = await createTestTeam(app.trainingDb, {
        slug: 'other',
        name: 'Other',
        support: 'support2',
        customer: 'bob',
    });
    foreign = other.credentials.supportToken;
    store = new DeliveryStore(testUrl.href);
    await store.initialize();
});

after(async () => {
    await store?.close();
    await app?.close();
    await master.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await master.end();
});

test('supported endpoints and DTO properties exist in the pinned official Jira specification', async () => {
    const official = JSON.parse(readFileSync('docs/vendor/jira-10.3.openapi.json', 'utf8'));
    assert.match(official.info.version, /^10\.3\./);
    for (const [path, method] of [
        ['/servicedeskapi/request', 'post'],
        ['/servicedeskapi/request', 'get'],
        ['/servicedeskapi/servicedesk/{serviceDeskId}/requesttype/{requestTypeId}/field', 'get'],
        ['/api/2/issue/{issueIdOrKey}/transitions', 'post'],
        ['/servicedeskapi/request/{issueIdOrKey}/comment', 'post'],
        ['/api/2/issue/{issueIdOrKey}/transitions', 'get'],
        ['/servicedeskapi/request/{issueIdOrKey}', 'get'],
        ['/servicedeskapi/request/{issueIdOrKey}/comment', 'get'],
        ['/api/2/user/assignable/search', 'get'],
        ['/api/2/issue/{issueIdOrKey}/assignee', 'put'],
    ])
        assert.ok(official.paths[path][method], `${method} ${path}`);
    const response = await app.inject({
        url: '/rest/servicedeskapi/servicedesk/3/requesttype/194/field',
        headers: authorization(customer),
    });
    assert.equal(response.statusCode, 200);
    const properties = official.components.schemas.RequestTypeFieldDTO.properties;
    for (const field of response.json().requestTypeFields)
        for (const property of Object.keys(field)) assert.ok(property in properties, property);
});

test('removed routes are really absent, not merely hidden in Swagger', async () => {
    for (const [method, url] of [
        ['GET', '/rest/servicedeskapi/servicedesk/3/requesttype'],
        ['GET', '/rest/api/2/issue/HELP-1'],
        ['GET', '/rest/servicedeskapi/servicedesk/3/queue'],
        ['GET', '/rest/servicedeskapi/servicedesk/3/queue/1/issue'],
        ['POST', '/rest/api/2/search'],
        ['GET', '/api/requests/HELP-1/history'],
    ] as const) {
        const response = await app.inject({ method, url, headers: authorization(support) });
        assert.equal(response.statusCode, 404, `${method} ${url}`);
    }
});

test('missing required fields and unsupported input do not create a request', async () => {
    for (const fields of [{}, { description: 'test', unknown: 'value' }]) {
        const result = await app.inject({
            method: 'POST',
            url: '/rest/servicedeskapi/request',
            headers: authorization(customer),
            payload: { serviceDeskId: '3', requestTypeId: '194', requestFieldValues: fields },
        });
        assert.equal(result.statusCode, 400);
    }
    const invalid = await app.inject({
        method: 'POST',
        url: '/rest/servicedeskapi/request',
        headers: authorization(customer),
        payload: { serviceDeskId: '3', requestTypeId: '183', requestFieldValues: { description: 'test' } },
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(invalid.json().errors.customfield_12900);
});

test('missing, ambiguous or unavailable default lead does not create a partial request', async () => {
    const totals = async () => ({
        issues: (await app.trainingDb.select().from(issues)).length,
        history: (await app.trainingDb.select().from(history)).length,
        outbox: (await app.trainingDb.select().from(outbox)).length,
    });
    const before = await totals();
    try {
        for (const mode of ['missing', 'ambiguous', 'ready'] as const) {
            defaultLeadMode = mode;
            directoryUnavailable = mode === 'ready';
            const response = await app.inject({
                method: 'POST',
                url: '/rest/servicedeskapi/request',
                headers: authorization(customer),
                payload: {
                    serviceDeskId: '3',
                    requestTypeId: '194',
                    requestFieldValues: { description: 'Не должно создаться без руководителя' },
                },
            });
            assert.equal(response.statusCode, 503);
            assert.match(response.json().errorMessages[0], /руководител/);
            assert.deepEqual(await totals(), before);
        }
    } finally {
        defaultLeadMode = 'ready';
        directoryUnavailable = false;
    }
});

test('creates official-shaped request and isolates it from another team', async () => {
    const response = await app.inject({
        method: 'POST',
        url: '/rest/servicedeskapi/request',
        headers: authorization(customer),
        payload: {
            serviceDeskId: '3',
            requestTypeId: '194',
            requestFieldValues: { description: 'Не удаётся войти', customfield_10713: { id: '13204' } },
        },
    });
    assert.equal(response.statusCode, 201, response.body);
    const request = response.json();
    key = request.issueKey;
    assert.match(key, /^HELP-\d+$/);
    assert.equal(request.currentStatus.status, 'Новая');
    assert.equal(request.reporter.name, 'alice');
    assert.deepEqual(request.assignee, { name: 'lead', key: 'lead', displayName: 'Руководитель поддержки' });
    const [initial] = await app.trainingDb
        .select()
        .from(issues)
        .where(eq(issues.id, Number(key.slice(5))));
    assert.equal(initial.assignee, 'lead');
    assert.equal(initial.assigneeDisplayName, 'Руководитель поддержки');
    const [createdHistory] = await app.trainingDb.select().from(history).where(eq(history.issueId, initial.id));
    assert.deepEqual(createdHistory.data, { status: '10005', assignee: 'lead' });
    const [createdEvent] = await app.trainingDb.select().from(outbox).where(eq(outbox.issueId, initial.id));
    assert.equal(
        (createdEvent.payload as { issue: { fields: { assignee: { name: string; displayName: string } } } }).issue
            .fields.assignee.displayName,
        'Руководитель поддержки'
    );
    const official = JSON.parse(readFileSync('docs/vendor/jira-10.3.openapi.json', 'utf8'));
    for (const property of Object.keys(request)) {
        if (property === 'assignee') {
            assert.deepEqual(
                request.assignee,
                { name: 'lead', key: 'lead', displayName: 'Руководитель поддержки' },
                'Explicit teaching extension for persisted assignment'
            );
            continue;
        }
        assert.ok(property in official.components.schemas.CustomerRequestDTO.properties, property);
    }
    assert.equal(
        (await app.inject({ url: `/rest/servicedeskapi/request/${key}`, headers: authorization(foreign) })).statusCode,
        404
    );
    assert.equal(
        (await app.inject({ url: `/rest/servicedeskapi/request/${key}`, headers: authorization(anotherCustomer) }))
            .statusCode,
        404
    );
    assert.equal((await app.inject({ url: `/rest/servicedeskapi/request/${key}` })).statusCode, 401);
    const own = await app.inject({ url: `/rest/servicedeskapi/request/${key}`, headers: authorization(customer) });
    assert.equal(
        own.json().requestFieldValues.find((field: { fieldId: string }) => field.fieldId === 'description').value,
        'Не удаётся войти'
    );
});

test('request list validates pagination and isolates applicants and Service Desks', async () => {
    const list = (token: string, query = '') =>
        app.inject({
            url: `/rest/servicedeskapi/request${query}`,
            headers: authorization(token),
        });
    assert.equal((await app.inject('/rest/servicedeskapi/request')).statusCode, 401);
    const empty = (await list(anotherCustomer)).json();
    assert.equal(empty.size, 0);
    const foreignList = (await list(foreign)).json();
    assert.equal(foreignList.size, 0);
    for (const query of [
        '?start=-1',
        '?start=1.5',
        '?limit=0',
        '?limit=101',
        '?requestStatus=UNKNOWN',
        '?reporter=eve',
        '?teamId=other',
    ])
        assert.equal((await list(support, query)).statusCode, 400, query);
    const own = (await list(customer)).json();
    assert.equal(own.values[0].issueKey, key);
    assert.equal(own.limit, 25);
    assert.equal(own.values[0].currentStatus.status, 'Новая');
    assert.equal(own.isLastPage, true);
    assert.equal((await list(customer, '?requestStatus=CLOSED_REQUESTS')).json().size, 0);
    assert.equal((await list(customer, '?requestStatus=OPEN_REQUESTS')).json().size, 1);

    const created = await app.inject({
        method: 'POST',
        url: '/rest/servicedeskapi/request',
        headers: authorization(anotherCustomer),
        payload: {
            serviceDeskId: '3',
            requestTypeId: '194',
            requestFieldValues: { description: 'Другой заявитель того же Service Desk' },
        },
    });
    assert.equal(created.statusCode, 201);
    const anotherKey = created.json().issueKey;
    assert.deepEqual(
        (await list(customer)).json().values.map((item: { issueKey: string }) => item.issueKey),
        [key]
    );
    assert.deepEqual(
        (await list(anotherCustomer)).json().values.map((item: { issueKey: string }) => item.issueKey),
        [anotherKey]
    );
    const first = (await list(support, '?limit=1&requestStatus=OPEN_REQUESTS')).json();
    assert.equal(first.size, 1);
    assert.equal(first.isLastPage, false);
    assert.equal(first.values[0].issueKey, anotherKey);
    const next = new URL(first._links.next);
    assert.equal(next.searchParams.get('requestStatus'), 'OPEN_REQUESTS');
    assert.equal(next.searchParams.get('limit'), '1');
    const last = (await list(support, next.search)).json();
    assert.equal(last.values[0].issueKey, key);
    assert.equal(last.isLastPage, true);
    assert.equal(last._links.next, undefined);
    assert.equal((await list(support, '?start=2&limit=1')).json().size, 0);
    assert.equal((await list(foreign)).json().size, 0);
    assert.equal((await list(serviceAdmin)).json().size, 2);
});

test('public and internal comments have different visibility', async () => {
    const url = `/rest/servicedeskapi/request/${key}/comment`;
    assert.equal(
        (
            await app.inject({
                method: 'POST',
                url,
                headers: authorization(customer),
                payload: { body: 'secret', public: false },
            })
        ).statusCode,
        403
    );
    for (const isPublic of [false, true])
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url,
                    headers: authorization(support),
                    payload: { body: isPublic ? 'Ответ клиенту' : 'Внутренняя заметка', public: isPublic },
                })
            ).statusCode,
            201
        );
    const visible = (await app.inject({ url, headers: authorization(customer) })).json();
    assert.equal(visible.values.length, 1);
    assert.equal(visible.values[0].body, 'Ответ клиенту');
    assert.equal((await app.inject({ url, headers: authorization(support) })).json().values.length, 2);
    assert.equal(
        (await app.inject({ method: 'POST', url, headers: authorization(support), payload: { body: 'x' } })).statusCode,
        400
    );
});

test('support selects current Identity assignees before their first login; assignment is atomic and scoped', async () => {
    const listUrl = '/rest/api/2/user/assignable/search';
    const assignUrl = `/rest/api/2/issue/${key}/assignee`;
    const assign = (token: string, name: string | null) =>
        app.inject({ method: 'PUT', url: assignUrl, headers: authorization(token), payload: { name } });
    assert.equal((await app.inject(listUrl)).statusCode, 401);
    assert.equal((await app.inject({ url: listUrl, headers: authorization(customer) })).statusCode, 403);
    assert.equal((await assign(customer, 'new-support')).statusCode, 403);
    assert.equal((await assign(foreign, 'new-support')).statusCode, 404);
    assert.equal(
        (await app.inject({ url: `${listUrl}?issueKey=${key}`, headers: authorization(foreign) })).statusCode,
        404
    );
    for (const query of ['?maxResults=0', '?maxResults=101', '?maxResults=1.5', '?startAt=0', '?user=support'])
        assert.equal(
            (await app.inject({ url: listUrl + query, headers: authorization(support) })).statusCode,
            400,
            query
        );
    assert.equal(
        (await app.inject({ url: `${listUrl}?project=OTHER`, headers: authorization(support) })).statusCode,
        404
    );
    const candidates = await app.inject({
        url: `${listUrl}?issueKey=${key}&project=HELP`,
        headers: authorization(support),
    });
    assert.equal(candidates.statusCode, 200);
    assert.deepEqual(
        candidates.json().map((user: { name: string }) => user.name),
        ['desk-admin', 'lead', 'new-support', 'support']
    );
    assert.equal(
        (await app.inject({ url: `${listUrl}?maxResults=1`, headers: authorization(serviceAdmin) })).json().length,
        1
    );
    const searched = (
        await app.inject({ url: `${listUrl}?username=NEW-SUPPORT`, headers: authorization(support) })
    ).json();
    assert.deepEqual(searched, [
        { name: 'new-support', key: 'new-support', displayName: 'Новый сотрудник', active: true },
    ]);
    assert.equal((await app.trainingDb.select().from(users).where(eq(users.username, 'new-support'))).length, 0);
    for (const invalid of ['alice', 'support2', 'disabled', '-1'])
        assert.equal((await assign(support, invalid)).statusCode, 400);
    assert.equal((await assign(support, 'new-support')).statusCode, 204);
    const issueId = Number(key.slice(5));
    const [assigned] = await app.trainingDb.select().from(issues).where(eq(issues.id, issueId));
    const historyAfterAssign = await app.trainingDb.select().from(history).where(eq(history.issueId, issueId));
    const assignment = historyAfterAssign.find((item) => item.action === 'assignee');
    assert.equal(assignment?.author, 'support');
    assert.deepEqual(assignment?.data, { from: 'lead', to: 'new-support' });
    const card = (
        await app.inject({ url: `/rest/servicedeskapi/request/${key}`, headers: authorization(customer) })
    ).json();
    assert.deepEqual(card.assignee, { name: 'new-support', key: 'new-support', displayName: 'Новый сотрудник' });
    const assignedEvents = await app.trainingDb.select().from(outbox).where(eq(outbox.issueId, issueId));
    const event = assignedEvents.find(
        (item) =>
            (item.payload as { issue?: { fields?: { assignee?: { name?: string } } } }).issue?.fields?.assignee
                ?.name === 'new-support'
    );
    assert.equal(event?.event, 'jira:issue_updated');
    assert.equal(
        (await assign(support, 'new-support')).statusCode,
        204,
        'No-op assignment succeeds without another write'
    );
    assert.equal(
        (await app.trainingDb.select().from(outbox).where(eq(outbox.issueId, issueId))).length,
        assignedEvents.length
    );
    newSupportEnabled = false;
    assert.equal(
        (await assign(support, 'new-support')).statusCode,
        400,
        'Eligibility is checked again, even for the current assignee'
    );
    assert.equal(
        (await app.inject({ url: `${listUrl}?username=new-support`, headers: authorization(support) })).json().length,
        0
    );
    directoryUnavailable = true;
    assert.equal((await assign(support, 'support')).statusCode, 503);
    assert.equal((await app.inject({ url: listUrl, headers: authorization(support) })).statusCode, 503);
    assert.equal(
        (await assign(serviceAdmin, null)).statusCode,
        204,
        'Removing assignment does not require a functioning directory'
    );
    directoryUnavailable = false;
    newSupportEnabled = true;
    const [cleared] = await app.trainingDb.select().from(issues).where(eq(issues.id, issueId));
    assert.equal(cleared.assignee, null);
    assert.equal(cleared.assigneeDisplayName, null);
    assert.equal(cleared.version, assigned.version + 1);
    const changes = await app.trainingDb.select().from(history).where(eq(history.issueId, issueId));
    assert.equal(changes.filter((item) => item.action === 'assignee').length, 2);
    assert.equal(
        (await app.trainingDb.select().from(outbox).where(eq(outbox.issueId, issueId))).length,
        assignedEvents.length + 1
    );
});

test('support-only processing workflow persists; invalid transitions are rejected', async () => {
    const url = `/rest/api/2/issue/${key}`;
    assert.equal((await app.inject(`${url}/transitions`)).statusCode, 401);
    const customerTransitions = await app.inject({ url: `${url}/transitions`, headers: authorization(customer) });
    assert.equal(customerTransitions.statusCode, 200);
    assert.deepEqual(
        customerTransitions.json().transitions.map((item: { id: string }) => item.id),
        ['10011']
    );
    assert.equal(
        (
            await app.inject({
                method: 'POST',
                url: `${url}/transitions`,
                headers: authorization(customer),
                payload: { transition: { id: '10006' } },
            })
        ).statusCode,
        403
    );
    assert.equal((await app.inject({ url: `${url}/transitions`, headers: authorization(foreign) })).statusCode, 404);
    assert.equal(
        (
            await app.inject({
                method: 'POST',
                url: `${url}/transitions`,
                headers: authorization(support),
                payload: { transition: { id: '10011' } },
            })
        ).statusCode,
        400
    );
    for (const id of ['10006', '10007', '10006', '10008', '10010']) {
        const transitions = (
            await app.inject({ url: `${url}/transitions?expand=transitions.fields`, headers: authorization(support) })
        ).json();
        assert.ok(transitions.transitions.some((transition: { id: string }) => transition.id === id));
        assert.equal(
            (
                await app.inject({
                    method: 'POST',
                    url: `${url}/transitions`,
                    headers: authorization(support),
                    payload: { transition: { id } },
                })
            ).statusCode,
            204
        );
    }
    assert.equal(
        (
            await app.inject({
                method: 'PUT',
                url: `${url}/assignee`,
                headers: authorization(support),
                payload: { name: 'lead' },
            })
        ).statusCode,
        204
    );
    assert.equal(
        (
            await app.inject({
                method: 'POST',
                url: `${url}/transitions`,
                headers: authorization(support),
                payload: { transition: { id: '10011' } },
            })
        ).statusCode,
        400
    );
    assert.equal(
        (
            await app.inject({
                method: 'POST',
                url: `${url}/transitions`,
                headers: authorization(support),
                payload: { transition: { id: '10011' }, fields: { resolution: { id: '10100' } } },
            })
        ).statusCode,
        204
    );
    const response = await app.inject({ url: `/rest/servicedeskapi/request/${key}`, headers: authorization(customer) });
    assert.equal(response.json().currentStatus.status, 'Закрыта');
    const closedList = await app.inject({
        url: '/rest/servicedeskapi/request?requestStatus=CLOSED_REQUESTS',
        headers: authorization(support),
    });
    assert.deepEqual(
        closedList.json().values.map((item: { issueKey: string }) => item.issueKey),
        [key]
    );
    const openList = await app.inject({
        url: '/rest/servicedeskapi/request?requestStatus=OPEN_REQUESTS',
        headers: authorization(support),
    });
    assert.equal(openList.json().size, 1);
    assert.ok(openList.json().values.every((item: { issueKey: string }) => item.issueKey !== key));

    const [issue] = await app.trainingDb
        .select()
        .from(issues)
        .where(eq(issues.id, Number(key.slice(5))));
    assert.equal(issue.resolution, 'Готово');
    assert.equal(issue.assignee, null);
    assert.equal(issue.assigneeDisplayName, null);
    const events = await app.trainingDb
        .select()
        .from(outbox)
        .where(eq(outbox.issueId, issue.id))
        .orderBy(asc(outbox.id));
    const changes = await app.trainingDb
        .select()
        .from(history)
        .where(eq(history.issueId, issue.id))
        .orderBy(asc(history.id));
    assert.equal(changes.filter((entry) => entry.action === 'status').length, 6);
    assert.ok(
        changes.some(
            (entry) => entry.action === 'status' && entry.data.to === '10011' && entry.data.previousAssignee === 'lead'
        )
    );
    assert.equal(events.length, changes.length);
    // UUID order is not event order; delivery order is deliberately not guaranteed.
    assert.equal(events.filter((entry) => entry.event === 'jira:issue_created').length, 1);
    assert.equal(events.filter((entry) => entry.event === 'jira:issue_updated').length, changes.length - 1);
    assert.equal(issue.version, changes.length);
});

test('stale issue updates are rejected and cannot overwrite the current version', async () => {
    const repository = new Repository(app.trainingDb);
    const issue = await repository.findIssue(teamId, Number(key.slice(5)));
    assert.ok(issue);
    const updated = await repository.updateIssue(issue, {});
    assert.ok(updated);
    assert.equal(updated.version, issue.version + 1);
    assert.equal(await repository.updateIssue(issue, { status: '10005' }), undefined);
    assert.equal((await repository.findIssue(teamId, issue.id))?.status, '10011');
});

test('applicant can close only own requests from every open status, with atomic history and event', async () => {
    for (const initialStatus of ['10005', '10006', '10007', '10008', '10009', '10010']) {
        const created = await app.inject({
            method: 'POST',
            url: '/rest/servicedeskapi/request',
            headers: authorization(customer),
            payload: {
                serviceDeskId: '3',
                requestTypeId: '194',
                requestFieldValues: { description: `Закрытие заявителем из ${initialStatus}` },
            },
        });
        assert.equal(created.statusCode, 201);
        const ownKey = created.json().issueKey;
        const issueId = Number(ownKey.slice(5));
        // Each fixture starts in a different supported workflow state; the closing action uses the public API.
        await app.trainingDb.update(issues).set({ status: initialStatus }).where(eq(issues.id, issueId));
        const url = `/rest/api/2/issue/${ownKey}/transitions`;
        const closePayload = { transition: { id: '10011' }, fields: { resolution: { id: '10100' } } };
        const available = await app.inject({
            url: `${url}?expand=transitions.fields`,
            headers: authorization(customer),
        });
        assert.equal(available.statusCode, 200);
        assert.deepEqual(
            available.json().transitions.map((item: { id: string }) => item.id),
            ['10011']
        );
        assert.equal(available.json().transitions[0].fields.resolution.required, true);
        assert.equal(available.json().transitions[0].fields.resolution.allowedValues[0].id, '10100');
        assert.equal(
            (await app.inject({ url, method: 'POST', headers: authorization(anotherCustomer), payload: closePayload }))
                .statusCode,
            404
        );
        assert.equal(
            (await app.inject({ url, method: 'POST', headers: authorization(foreign), payload: closePayload }))
                .statusCode,
            404
        );
        assert.equal((await app.inject({ url, headers: authorization(anotherCustomer) })).statusCode, 404);
        assert.equal(
            (
                await app.inject({
                    url,
                    method: 'POST',
                    headers: authorization(customer),
                    payload: { transition: { id: '10006' } },
                })
            ).statusCode,
            403
        );
        assert.equal(
            (
                await app.inject({
                    url,
                    method: 'POST',
                    headers: authorization(customer),
                    payload: { transition: { id: '10011' } },
                })
            ).statusCode,
            400
        );
        assert.equal(
            (await app.inject({ url, method: 'POST', headers: authorization(customer), payload: closePayload }))
                .statusCode,
            204
        );
        const repeated = await app.inject({
            url,
            method: 'POST',
            headers: authorization(customer),
            payload: closePayload,
        });
        assert.equal(repeated.statusCode, 409);
        assert.match(repeated.json().errorMessages[0], /уже закрыто/);
        assert.deepEqual((await app.inject({ url, headers: authorization(customer) })).json().transitions, []);
        const [closed] = await app.trainingDb.select().from(issues).where(eq(issues.id, issueId));
        assert.equal(closed.status, '10011');
        assert.equal(closed.resolution, 'Готово');
        assert.equal(closed.assignee, null);
        assert.equal(closed.assigneeDisplayName, null);
        assert.equal(closed.version, 2);
        const changes = await app.trainingDb.select().from(history).where(eq(history.issueId, issueId));
        assert.equal(changes.length, 2, 'Denied/repeated requests did not write extra history');
        const change = changes.find((item) => item.action === 'status');
        assert.equal(change?.author, 'alice');
        assert.deepEqual(change?.data, { from: initialStatus, to: '10011', previousAssignee: 'lead' });
        const events = await app.trainingDb.select().from(outbox).where(eq(outbox.issueId, issueId));
        assert.equal(events.length, 2, 'Create and close each produced one event');
        const changed = events.find((item) => item.event === 'jira:issue_updated');
        assert.ok(changed);
        assert.equal((changed.payload as { issue: { fields: { assignee: unknown } } }).issue.fields.assignee, null);
        assert.equal(
            (changed.payload as { issue: { fields: { status: { id: string }; resolution: { id: string } } } }).issue
                .fields.status.id,
            '10011'
        );
        const closedList = (
            await app.inject({
                url: '/rest/servicedeskapi/request?requestStatus=CLOSED_REQUESTS',
                headers: authorization(customer),
            })
        ).json();
        assert.ok(closedList.values.some((item: { issueKey: string }) => item.issueKey === ownKey));
    }
});

test('outbox survives restart, delivers after registration, and schedules retry after failure', async () => {
    await app.trainingDb
        .insert(subscriptions)
        .values({ teamId, url: 'https://example.com/webhook', secret: 'a'.repeat(32) });
    const created = await app.inject({
        method: 'POST',
        url: '/rest/servicedeskapi/request',
        headers: authorization(customer),
        payload: {
            serviceDeskId: '3',
            requestTypeId: '194',
            requestFieldValues: { description: 'Webhook delivery test' },
        },
    });
    await store.prepare();
    await store.close();
    store = new DeliveryStore(testUrl.href);
    let received = '';
    assert.ok(
        await deliverNext(store, async (_url, _secret, _id, payload) => {
            received = payload;
            return 503;
        })
    );
    assert.equal(JSON.parse(received).webhookEvent, 'jira:issue_created');
    assert.equal(JSON.parse(received).issue.fields.assignee.name, 'lead');
    assert.equal(JSON.parse(received).issue.fields.assignee.displayName, 'Руководитель поддержки');
    const deliveries = await store.list(teamId);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].state, 'pending');
    assert.ok(new Date(deliveries[0].next_attempt_at).getTime() > Date.now());
    assert.ok(await store.retry(teamId, deliveries[0].id));
    assert.ok(await deliverNext(store, async () => 204));
    assert.equal((await store.list(teamId))[0].state, 'delivered');
    const close = await app.inject({
        method: 'POST',
        url: `/rest/api/2/issue/${created.json().issueKey}/transitions`,
        headers: authorization(customer),
        payload: {
            transition: { id: '10011' },
            fields: { resolution: { id: '10100' } },
        },
    });
    assert.equal(close.statusCode, 204);
    await store.prepare();
    let updatePayload:
        | {
              webhookEvent: string;
              issue: { key: string; fields: { status: { id: string }; resolution: { id: string } } };
          }
        | undefined;
    assert.ok(
        await deliverNext(store, async (_url, _secret, _id, body) => {
            updatePayload = JSON.parse(body);
            return 204;
        })
    );
    assert.equal(updatePayload?.webhookEvent, 'jira:issue_updated');
    assert.equal(updatePayload?.issue.key, created.json().issueKey);
    assert.equal(updatePayload?.issue.fields.status.id, '10011');
    assert.equal(updatePayload?.issue.fields.resolution.id, '10100');
    assert.equal(
        (updatePayload as { issue: { fields: { assignee: unknown } } } | undefined)?.issue.fields.assignee,
        null
    );
    assert.equal((await store.list(teamId)).filter((item) => item.state === 'delivered').length, 2);
});

test('private networks and non-HTTPS webhook URLs are rejected', async () => {
    for (const ip of [
        '127.0.0.1',
        '10.0.0.1',
        '169.254.169.254',
        '192.168.1.2',
        '::1',
        '::ffff:127.0.0.1',
        'fc00::1',
        '100.64.0.1',
    ])
        assert.equal(isPublicAddress(ip), false, ip);
    assert.equal(isPublicAddress('1.1.1.1'), true);
    for (const url of [
        'http://example.com',
        'https://127.0.0.1',
        'https://user:pass@example.com',
        'https://example.com:8080',
    ])
        await assert.rejects(resolveDestination(url));
});

test('revoking a team disables existing bearer access', async () => {
    await app.trainingDb.update(teams).set({ active: false }).where(eq(teams.id, teamId));
    assert.equal(
        (await app.inject({ url: `/rest/servicedeskapi/request/${key}`, headers: authorization(support) })).statusCode,
        401
    );
});
