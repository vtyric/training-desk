import { URLSearchParams } from 'node:url';
import { configureAccessModel } from './configure-access-model.mjs';
import { configureDirectoryClient } from './configure-directory-client.mjs';
import { configureSupportLead } from './configure-support-lead.mjs';
import { renameDemoSupportLogin } from './rename-support-login.mjs';
import { renameSupportRole } from './rename-support-role.mjs';
/** Initial user/role provisioning plus managed Swagger client reconciliation; users/roles remain operator-managed. */
const origin = (process.env.IDENTITY_PUBLIC_URL || 'http://localhost:8081').replace(/\/$/, '');
const admin = process.env.IDENTITY_ADMIN_USERNAME || 'administrator';
const password = process.env.IDENTITY_ADMIN_PASSWORD;
if (!password) throw new Error('IDENTITY_ADMIN_PASSWORD is required');
const response = await fetch(`${origin}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: admin, password }),
});
if (!response.ok) throw new Error(`Identity admin authentication failed (${response.status})`);
const { access_token: token } = await response.json();
async function api(path, method = 'GET', data) {
    const r = await fetch(`${origin}/admin/realms/training${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    if (!r.ok) throw new Error(`Identity provisioning failed: ${method} ${path} (${r.status})`);
    const body = await r.text();
    return body ? JSON.parse(body) : null;
}
await renameSupportRole(api);
const realm = await api('');
if (realm.attributes?.['training.bootstrap.configured'] === '1') {
    console.log('Identity is already configured; existing users and roles were not changed.');
} else {
    const permissions = { view: ['admin', 'user'], edit: ['admin'] };
    await api('/users/profile', 'PUT', {
        attributes: [
            { name: 'username', displayName: 'Логин', validations: { length: { min: 1, max: 128 } }, permissions },
            { name: 'email', displayName: 'Email', validations: { email: {} }, permissions },
            { name: 'firstName', displayName: 'Имя', required: { roles: ['admin'] }, permissions },
            { name: 'lastName', displayName: 'Фамилия', required: { roles: ['admin'] }, permissions },
            {
                name: 'team_slug',
                displayName: 'Учебная команда (slug)',
                required: { roles: ['admin'] },
                validations: { pattern: { pattern: '^[a-z][a-z0-9-]{1,39}$' } },
                permissions: { view: ['admin'], edit: ['admin'] },
            },
        ],
        groups: [],
    });
    const providers = await api('/components?type=org.keycloak.storage.UserStorageProvider');
    const ldap = providers.find((p) => p.providerId === 'ldap');
    if (!ldap) throw new Error('LDAP federation provider is missing');
    await api(`/user-storage/${ldap.id}/sync?action=triggerFullSync`, 'POST');
    await renameDemoSupportLogin(api);
    const clients = await api('/clients?clientId=service-desk');
    const client = clients.find((c) => c.clientId === 'service-desk');
    if (!client) throw new Error('Service Desk resource client is missing');
    for (const [username, names] of [
        ['alice', ['customer']],
        ['support', ['customer', 'support']],
    ]) {
        const users = await api(`/users?username=${encodeURIComponent(username)}&exact=true`);
        if (users.length !== 1) throw new Error(`Initial LDAP user ${username} was not imported`);
        const roles = await Promise.all(names.map((name) => api(`/clients/${client.id}/roles/${name}`)));
        await api(`/users/${users[0].id}/role-mappings/clients/${client.id}`, 'POST', roles);
    }
    await api('', 'PUT', { ...realm, attributes: { ...realm.attributes, 'training.bootstrap.configured': '1' } });
    console.log('Identity configured: managed profile, LDAP users and initial Service Desk roles.');
}

// Managed Swagger client is reconciled separately from the one-time user/role bootstrap.
// Existing users, role mappings and other clients are never reset here.
const swaggerOrigins = [
    ...new Set(
        [
            process.env.DOCKER_BASE_URL || 'http://localhost:8080',
            process.env.API_DOCS_DEV_URL || 'http://localhost:3000',
        ].map((value) => {
            const url = new URL(value);
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password ||
                url.pathname !== '/' ||
                url.search ||
                url.hash
            )
                throw new Error('Swagger client origins must be HTTP(S) origins without credentials, paths or queries');
            return url.origin;
        })
    ),
];
const sourceClient = (await api('/clients?clientId=service-desk-test')).find(
    (client) => client.clientId === 'service-desk-test'
);
if (!sourceClient) throw new Error('Test UI client is missing; cannot configure Swagger claims');
const existingSwagger = (await api('/clients?clientId=service-desk-swagger')).find(
    (client) => client.clientId === 'service-desk-swagger'
);
const swaggerClient = {
    clientId: 'service-desk-swagger',
    name: 'Service Desk Swagger',
    baseUrl: `${swaggerOrigins[0]}/docs/`,
    enabled: true,
    protocol: 'openid-connect',
    publicClient: true,
    bearerOnly: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: swaggerOrigins.map((url) => `${url}/docs/static/oauth2-redirect.html`),
    webOrigins: swaggerOrigins,
    attributes: {
        ...(existingSwagger?.attributes || {}),
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': swaggerOrigins.map((url) => `${url}/docs/`).join('##'),
    },
    protocolMappers: (sourceClient.protocolMappers || []).map((mapper) => {
        const copy = { ...mapper };
        delete copy.id;
        return copy;
    }),
};
if (existingSwagger) await api(`/clients/${existingSwagger.id}`, 'PUT', { ...existingSwagger, ...swaggerClient });
else await api('/clients', 'POST', swaggerClient);
console.log('Swagger public client configured: Code + PKCE, exact callbacks and logout redirects.');

await renameDemoSupportLogin(api);
await configureAccessModel(api, process.env.DESK_ADMIN_PASSWORD);

// One-time wording update, preserving all role names, grants and administrator-managed memberships.
const labelsRealm = await api('');
if (labelsRealm.attributes?.['training.access-labels.version'] !== '1') {
    const [resource] = await api('/clients?clientId=service-desk');
    for (const [role, description] of [
        ['customer', 'Заявитель: создание и просмотр своих обращений'],
        ['support', 'Сотрудник поддержки: обработка обращений, статусы и исполнители'],
        ['admin', 'Администратор Service Desk: все настройки сервиса и обработка обращений'],
    ]) {
        const current = await api(`/clients/${resource.id}/roles/${role}`);
        await api(`/clients/${resource.id}/roles/${role}`, 'PUT', { ...current, description });
    }
    await api('', 'PUT', {
        ...labelsRealm,
        attributes: { ...labelsRealm.attributes, 'training.access-labels.version': '1' },
    });
    console.log('Service Desk role descriptions updated; existing access rights preserved.');
}

await configureDirectoryClient(api, process.env.IDENTITY_DIRECTORY_CLIENT_SECRET);

await configureSupportLead(api, process.env.SUPPORT_LEAD_PASSWORD);

// Publish readable names without changing identifiers used by integrations.
const nameClients = ['service-desk-test', 'service-desk-swagger', 'student-service'];
for (const clientId of nameClients) {
    const [client] = await api(`/clients?clientId=${clientId}`);
    const mappers = client.protocolMappers || [];
    if (!mappers.some((mapper) => mapper.protocolMapper === 'oidc-full-name-mapper')) {
        await api(`/clients/${client.id}/protocol-mappers/models`, 'POST', {
            name: 'Имя пользователя',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-full-name-mapper',
            consentRequired: false,
            config: { 'access.token.claim': 'true', 'id.token.claim': 'true', 'userinfo.token.claim': 'true' },
        });
    }
}
console.log('Readable user names are available to the portal; login identifiers preserved.');
