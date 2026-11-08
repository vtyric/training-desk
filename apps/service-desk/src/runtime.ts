import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import staticFiles from '@fastify/static';
import { registerSwagger } from './api/swagger';
import { KeycloakDirectory, createAccessTokenAuth } from '../../../libs/auth';
import { createSettings, SettingsLogic, registerSettingsRoutes } from '../../../libs/settings';
import { DeliveryStore } from '../../../libs/webhooks/dal/store';
import { resolveDestination } from '../../../libs/webhooks/dal/destination';
import { startWorker } from '../../../libs/webhooks/logic/worker';
import { buildApp } from './app';
import { teams } from './dal/schema';
import type { Database } from './dal/database';
import { DomainError } from './logic/types';

/** Standalone Service Desk: JWT resource API + its test UI. Identity owns passwords and roles. */
export async function buildRuntimeApp(env: NodeJS.ProcessEnv = process.env, logger = true) {
    const settings = await createSettings(
        resolve('config/backend.json'),
        resolve(env['SETTINGS_FILE'] || '.local/settings/backend.json')
    );
    const config = settings.getActiveConfig();
    const databaseUrl = required(env, config.database.urlEnv);
    const baseUrl = required(env, 'BASE_URL').replace(/\/$/, '');
    const production = env['NODE_ENV'] === 'production';
    if (production && new URL(baseUrl).protocol !== 'https:') throw new Error('Production requires HTTPS BASE_URL');
    let db: Database;
    const auth = createAccessTokenAuth(
        {
            issuerUrl: required(env, config.identity.issuerUrlEnv),
            internalIssuerUrl: env[config.identity.internalIssuerUrlEnv] || undefined,
            audience: config.identity.audience,
            allowInsecureLocal: !production && config.identity.allowInsecureLocal,
        },
        async (slug) => {
            const [team] = await db
                .select({ id: teams.id })
                .from(teams)
                .where(and(eq(teams.slug, slug), eq(teams.active, true)));
            return team?.id ?? null;
        }
    );
    const directory = new KeycloakDirectory({
        issuerUrl: required(env, config.identity.issuerUrlEnv),
        internalIssuerUrl: env[config.identity.internalIssuerUrlEnv] || undefined,
        resourceClientId: config.identity.audience,
        clientId: config.identity.directoryClientId,
        clientSecret: required(env, config.identity.directoryClientSecretEnv),
        allowInsecureLocal: !production && config.identity.allowInsecureLocal,
        timeoutMs: config.identity.directoryTimeoutMs,
    });
    const deliveries = new DeliveryStore(databaseUrl);
    const validateWebhookUrl = async (url: string) => {
        try {
            await resolveDestination(url);
        } catch {
            throw new DomainError(400, 'Webhook должен указывать на публичный HTTPS-адрес');
        }
    };
    const app = await buildApp({
        databaseUrl,
        baseUrl,
        logger,
        bodyLimit: config.server.bodyLimit,
        poolMax: config.database.poolMax,
        allowLegacyApiTokens: config.security.allowLegacyApiTokens,
        adminToken: required(env, 'ADMIN_TOKEN'),
        authenticateToken: auth.authenticateToken,
        assigneeDirectory: directory,
        configureApp: async (instance) => {
            db = instance.trainingDb;
            await registerSwagger(
                instance,
                config.service.name,
                required(env, config.identity.issuerUrlEnv),
                readFileSync(resolve(env['STATIC_DIR'] ?? 'libs/theme/assets', 'brand/favicon.svg'))
            );
        },
        registerFeatures: async (instance, _authenticate, authenticateAdmin) => {
            await registerSettingsRoutes(instance, new SettingsLogic(settings, validateWebhookUrl), authenticateAdmin);
        },
    });
    try {
        await deliveries.initialize();
        const master = required(env, 'WEBHOOK_SIGNING_SECRET');
        const stop = startWorker(deliveries, (error) => app.log.error({ err: error }, 'Webhook worker failed'), {
            ...config.webhooks,
            projectSettings: async () => {
                const desired = await settings.read();
                await deliveries.projectSettings(desired.teams, (teamId) =>
                    createHmac('sha256', master).update(teamId).digest('hex')
                );
            },
        });
        app.addHook('onClose', stop);
        app.get('/api/config', { schema: { security: [] } }, async () => ({
            service: { name: config.service.name },
            identity: {
                url: required(env, config.ui.identityUrlEnv),
                realm: config.ui.realm,
                clientId: config.ui.publicClientId,
            },
        }));
        const staticDir = env['STATIC_DIR'] ? resolve(env['STATIC_DIR']) : undefined;
        if (config.ui.enabled && staticDir) {
            if (!existsSync(resolve(staticDir, 'index.html')))
                throw new Error('STATIC_DIR must contain the built Service Desk UI');
            await app.register(staticFiles, { root: staticDir, wildcard: false });
            for (const route of ['/requests', '/requests/:key', '/auth/callback'])
                app.get(route, (_req, reply) => reply.sendFile('index.html'));
        }
        app.decorate('listenSettings', config.server);
        return app;
    } catch (error) {
        await deliveries.close();
        await app.close();
        throw error;
    }
}
function required(env: NodeJS.ProcessEnv, key: string): string {
    const value = env[key];
    if (!value || value === 'CHANGE_ME') throw new Error(`${key} must be configured`);
    return value;
}
