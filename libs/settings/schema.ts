import { SettingsError, type GlobalSettings, type SettingsDocument } from './types';

const globalKeys = ['security', 'server', 'database', 'identity', 'service', 'webhooks', 'ui'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(path: string): never {
    throw new SettingsError(400, `Проверьте настройку ${path}`);
}
function record(input: unknown, path: string): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid(path);
    return input as Record<string, unknown>;
}
function exact(input: unknown, keys: string[], path: string, optional: string[] = []): Record<string, unknown> {
    const value = record(input, path);
    if (
        Object.keys(value).some((key) => !keys.includes(key)) ||
        keys.some((key) => !optional.includes(key) && !Object.hasOwn(value, key))
    )
        invalid(path);
    return value;
}
function text(input: unknown, path: string, pattern?: RegExp): string {
    if (typeof input !== 'string' || !input.trim() || input.length > 200 || (pattern && !pattern.test(input)))
        return invalid(path);
    return input;
}
function integer(input: unknown, min: number, max: number, path: string): number {
    if (!Number.isInteger(input) || typeof input !== 'number' || input < min || input > max) return invalid(path);
    return input;
}
function bool(input: unknown, path: string): boolean {
    if (typeof input !== 'boolean') return invalid(path);
    return input;
}
function env(input: unknown, path: string, expected: string) {
    if (input !== expected) return invalid(path);
    return expected;
}

/** Strict known-key JSON structure; secret-bearing values may only be environment variable names. */
export function validateGlobalSettings(input: unknown): GlobalSettings {
    const value = exact(input, globalKeys, 'config', ['security']);
    const security =
        value['security'] === undefined
            ? { allowLegacyApiTokens: false }
            : exact(value['security'], ['allowLegacyApiTokens'], 'security');
    const server = exact(value['server'], ['host', 'port', 'bodyLimit'], 'server');
    const database = exact(value['database'], ['urlEnv', 'poolMax'], 'database');
    const identity = exact(
        value['identity'],
        [
            'issuerUrlEnv',
            'internalIssuerUrlEnv',
            'audience',
            'allowInsecureLocal',
            'directoryClientId',
            'directoryClientSecretEnv',
            'directoryTimeoutMs',
        ],
        'identity',
        ['directoryClientId', 'directoryClientSecretEnv', 'directoryTimeoutMs']
    );
    const service = exact(value['service'], ['name', 'projectKey', 'serviceDeskId'], 'service');
    const webhooks = exact(
        value['webhooks'],
        ['pollIntervalMs', 'timeoutMs', 'batchSize', 'retryDelaysMs'],
        'webhooks'
    );
    const ui = exact(value['ui'], ['enabled', 'publicClientId', 'realm', 'identityUrlEnv'], 'ui');
    const delays = webhooks['retryDelaysMs'];
    if (!Array.isArray(delays) || delays.length > 10) invalid('webhooks.retryDelaysMs');
    return {
        security: { allowLegacyApiTokens: bool(security['allowLegacyApiTokens'], 'security.allowLegacyApiTokens') },
        server: {
            host: text(server['host'], 'server.host'),
            port: integer(server['port'], 1, 65535, 'server.port'),
            bodyLimit: integer(server['bodyLimit'], 1024, 16777216, 'server.bodyLimit'),
        },
        database: {
            urlEnv: env(database['urlEnv'], 'database.urlEnv', 'DATABASE_URL'),
            poolMax: integer(database['poolMax'], 1, 100, 'database.poolMax'),
        },
        identity: {
            issuerUrlEnv: env(identity['issuerUrlEnv'], 'identity.issuerUrlEnv', 'OIDC_ISSUER_URL'),
            internalIssuerUrlEnv: env(
                identity['internalIssuerUrlEnv'],
                'identity.internalIssuerUrlEnv',
                'OIDC_INTERNAL_ISSUER_URL'
            ),
            audience: text(identity['audience'], 'identity.audience', /^[A-Za-z0-9._-]+$/),
            allowInsecureLocal: bool(identity['allowInsecureLocal'], 'identity.allowInsecureLocal'),
            directoryClientId: text(
                identity['directoryClientId'] ?? 'service-desk-directory',
                'identity.directoryClientId',
                /^[A-Za-z0-9._-]+$/
            ),
            directoryClientSecretEnv: env(
                identity['directoryClientSecretEnv'] ?? 'IDENTITY_DIRECTORY_CLIENT_SECRET',
                'identity.directoryClientSecretEnv',
                'IDENTITY_DIRECTORY_CLIENT_SECRET'
            ),
            directoryTimeoutMs: integer(
                identity['directoryTimeoutMs'] ?? 10000,
                1000,
                30000,
                'identity.directoryTimeoutMs'
            ),
        },
        service: {
            name: text(service['name'], 'service.name'),
            projectKey: text(service['projectKey'], 'service.projectKey', /^HELP$/),
            serviceDeskId: text(service['serviceDeskId'], 'service.serviceDeskId', /^3$/),
        },
        webhooks: {
            pollIntervalMs: integer(webhooks['pollIntervalMs'], 100, 60000, 'webhooks.pollIntervalMs'),
            timeoutMs: integer(webhooks['timeoutMs'], 1000, 60000, 'webhooks.timeoutMs'),
            batchSize: integer(webhooks['batchSize'], 1, 100, 'webhooks.batchSize'),
            retryDelaysMs: delays.map((delay) => integer(delay, 100, 3600000, 'webhooks.retryDelaysMs')),
        },
        ui: {
            enabled: bool(ui['enabled'], 'ui.enabled'),
            publicClientId: text(ui['publicClientId'], 'ui.publicClientId', /^[A-Za-z0-9._-]+$/),
            realm: text(ui['realm'], 'ui.realm', /^[A-Za-z0-9._-]+$/),
            identityUrlEnv: env(ui['identityUrlEnv'], 'ui.identityUrlEnv', 'IDENTITY_PUBLIC_URL'),
        },
    };
}

export function globalSettings(document: SettingsDocument): GlobalSettings {
    return validateGlobalSettings(
        Object.fromEntries(globalKeys.map((key) => [key, document[key as keyof GlobalSettings]]))
    );
}

export function validateSettingsDocument(input: unknown): SettingsDocument {
    const value = exact(input, ['version', 'revision', ...globalKeys, 'teams'], 'settings', ['security']);
    if (value['version'] !== 1) invalid('version');
    const revision = integer(value['revision'], 0, Number.MAX_SAFE_INTEGER, 'revision');
    const teams = record(value['teams'], 'teams');
    const checkedTeams: SettingsDocument['teams'] = {};
    for (const [id, entry] of Object.entries(teams)) {
        if (!uuid.test(id)) invalid('teams.id');
        const team = exact(entry, ['webhook'], `teams.${id}`);
        const webhook = exact(team['webhook'], ['id', 'url', 'enabled', 'createdAt'], `teams.${id}.webhook`);
        if (webhook['id'] !== id) invalid(`teams.${id}.webhook.id`);
        const url = webhook['url'];
        const enabled = bool(webhook['enabled'], `teams.${id}.webhook.enabled`);
        if (typeof url !== 'string' || url.length > 2000 || (enabled && !url)) invalid(`teams.${id}.webhook.url`);
        if (url) {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                return invalid(`teams.${id}.webhook.url`);
            }
            if (
                parsed.protocol !== 'https:' ||
                parsed.username ||
                parsed.password ||
                parsed.hash ||
                (parsed.port && parsed.port !== '443')
            )
                invalid(`teams.${id}.webhook.url`);
        }
        const createdAt = webhook['createdAt'];
        if (
            typeof createdAt !== 'string' ||
            !Number.isFinite(Date.parse(createdAt)) ||
            new Date(createdAt).toISOString() !== createdAt
        )
            invalid(`teams.${id}.webhook.createdAt`);
        checkedTeams[id] = { webhook: { id, url, enabled, createdAt } };
    }
    return {
        version: 1,
        revision,
        ...validateGlobalSettings(Object.fromEntries(globalKeys.map((key) => [key, value[key]]))),
        teams: checkedTeams,
    };
}
