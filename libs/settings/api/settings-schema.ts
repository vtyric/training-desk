const text = { type: 'string', minLength: 1, maxLength: 200 };
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const object = (properties: Record<string, unknown>) => ({
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
});
const env = (name: string) => ({ type: 'string', enum: [name] });
const uuid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** Documents the same JSON persisted by SettingsStore; secret values are never accepted. */
export const settingsDocumentSchema = object({
    version: { type: 'integer', enum: [1] },
    revision: {
        ...integer(0, Number.MAX_SAFE_INTEGER),
        description: 'Номер редакции настроек. Защищает от перезаписи чужих изменений.',
    },
    server: object({ host: text, port: integer(1, 65535), bodyLimit: integer(1024, 16777216) }),
    database: object({ urlEnv: env('DATABASE_URL'), poolMax: integer(1, 100) }),
    identity: object({
        issuerUrlEnv: env('OIDC_ISSUER_URL'),
        internalIssuerUrlEnv: env('OIDC_INTERNAL_ISSUER_URL'),
        audience: { ...text, pattern: '^[A-Za-z0-9._-]+$' },
        allowInsecureLocal: { type: 'boolean' },
        directoryClientId: { ...text, pattern: '^[A-Za-z0-9._-]+$' },
        directoryClientSecretEnv: env('IDENTITY_DIRECTORY_CLIENT_SECRET'),
        directoryTimeoutMs: integer(1000, 30000),
    }),
    service: object({ name: text, projectKey: env('HELP'), serviceDeskId: env('3') }),
    webhooks: object({
        pollIntervalMs: integer(100, 60000),
        timeoutMs: integer(1000, 60000),
        batchSize: integer(1, 100),
        retryDelaysMs: { type: 'array', maxItems: 10, items: integer(100, 3600000) },
    }),
    ui: object({
        enabled: { type: 'boolean' },
        publicClientId: { ...text, pattern: '^[A-Za-z0-9._-]+$' },
        realm: { ...text, pattern: '^[A-Za-z0-9._-]+$' },
        identityUrlEnv: env('IDENTITY_PUBLIC_URL'),
    }),
    security: object({ allowLegacyApiTokens: { type: 'boolean' } }),
    teams: {
        type: 'object',
        description: 'Получатели уведомлений об обращениях. Ключ — идентификатор службы поддержки (teamId).',
        propertyNames: { pattern: uuid },
        additionalProperties: object({
            webhook: object({
                id: { type: 'string', pattern: uuid },
                url: { type: 'string', maxLength: 2000, description: 'Общедоступный HTTPS-адрес для уведомлений.' },
                enabled: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
            }),
        }),
    },
});

/** Object fields are optional for PATCH; array items retain their complete element schema. */
function partialObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (schema.type !== 'object') return structuredClone(schema);
    const result = structuredClone(schema);
    delete result.required;
    if (schema.properties && typeof schema.properties === 'object')
        result.properties = Object.fromEntries(
            Object.entries(schema.properties).map(([key, value]) => [
                key,
                partialObjectSchema(value as Record<string, unknown>),
            ])
        );
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        result.additionalProperties = partialObjectSchema(schema.additionalProperties as Record<string, unknown>);
    return result;
}
const partialSettings = partialObjectSchema(settingsDocumentSchema);
const partialProperties = partialSettings.properties as Record<string, unknown>;
delete partialProperties.version;
delete partialProperties.revision;
export const settingsPatchSchema = { ...partialSettings, minProperties: 1 };
