import { timingSafeEqual } from 'node:crypto';
import fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { AuthError } from '../../../libs/auth/types';
import { registerIdentityRoutes } from './api/identity-routes';
import { registerRoutes } from './api/routes';
import { createDatabase, type Database } from './dal/database';
import { SettingsError } from '../../../libs/settings/types';
import { RequestLogic } from './logic/requests';
import { DomainError, type Principal, type AssigneeDirectory } from './logic/types';

declare module 'fastify' {
    interface FastifyInstance {
        trainingDb: Database;
    }
}

export interface AppOptions {
    databaseUrl?: string;
    adminToken?: string;
    baseUrl?: string;
    logger?: boolean;
    configureApp?: (app: FastifyInstance) => Promise<void>;
    authenticateToken?: (token: string) => Promise<(Principal & { expiresAt?: number }) | null>;
    allowLegacyApiTokens?: boolean;
    bodyLimit?: number;
    poolMax?: number;
    assigneeDirectory?: AssigneeDirectory;
    registerFeatures?: (
        app: FastifyInstance,
        authenticate: (request: FastifyRequest) => Promise<Principal>,
        authenticateAdmin: (request: FastifyRequest) => Promise<void>
    ) => Promise<void>;
}

export async function buildApp(options: AppOptions = {}) {
    const databaseUrl = options.databaseUrl ?? process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const { db, close } = createDatabase(databaseUrl, options.poolMax);
    const app = fastify({
        logger: options.logger
            ? {
                  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
                  serializers: {
                      req: (request) => ({
                          method: request.method,
                          url: request.url?.split('?')[0],
                          hostname: request.hostname,
                          remoteAddress: request.ip,
                      }),
                  },
              }
            : false,
        bodyLimit: options.bodyLimit ?? 128 * 1024,
        ajv: { customOptions: { removeAdditional: false } },
    });
    app.decorate('trainingDb', db);
    app.addHook('onClose', close);
    app.setErrorHandler<FastifyError>((error, _request, reply) => {
        if (error instanceof SettingsError)
            return reply.code(error.statusCode).send({ errorMessages: [error.message], errors: {} });
        if (error instanceof DomainError)
            return reply.code(error.statusCode).send({ errorMessages: [error.message], errors: error.errors });
        if (error instanceof AuthError && [400, 401, 403, 503].includes(error.statusCode))
            return reply.code(error.statusCode).send({ errorMessages: [error.message], errors: {} });
        if (error.validation)
            return reply.code(400).send({
                errorMessages: ['Проверьте поля запроса и отправьте его ещё раз.'],
                errors: Object.fromEntries(
                    error.validation.map((entry) => [
                        entry.instancePath || '/',
                        entry.message ?? 'Проверьте значение поля',
                    ])
                ),
            });
        const cause = error.cause as { code?: string } | undefined;
        if ((error as { code?: string }).code === '23505' || cause?.code === '23505')
            return reply.code(409).send({
                errorMessages: ['Запись с таким идентификатором уже есть. Выберите другой идентификатор.'],
                errors: {},
            });
        app.log.error(error);
        return reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({
            errorMessages: [
                error.statusCode === 404
                    ? 'Адрес не найден. Проверьте путь запроса.'
                    : 'Не удалось выполнить запрос. Попробуйте позже.',
            ],
            errors: {},
        });
    });
    app.setNotFoundHandler((_request, reply) =>
        reply.code(404).send({ errorMessages: ['Адрес или метод не найден. Проверьте путь запроса.'], errors: {} })
    );
    const baseUrl = (options.baseUrl ?? process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
    const logic = new RequestLogic(db, baseUrl, options.assigneeDirectory);
    const authenticate = async (request: FastifyRequest): Promise<Principal> => {
        const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
        if (!token) throw new DomainError(401, 'Войдите в систему и повторите запрос.');
        if (options.authenticateToken && token.split('.').length === 3) {
            const principal = await options.authenticateToken(token);
            if (!principal) throw new DomainError(401, 'Сессия завершена. Войдите снова.');
            return principal;
        }
        const principal = (options.allowLegacyApiTokens ?? true) ? await logic.repository.authenticate(token) : null;
        if (!principal) throw new DomainError(401, 'Сессия завершена. Войдите снова.');
        return principal;
    };
    const authenticateAdmin = async (request: FastifyRequest) => {
        const expected = options.adminToken ?? process.env['ADMIN_TOKEN'];
        const actual = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
        if (
            expected &&
            expected.length >= 32 &&
            actual &&
            Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
            timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
        )
            return;
        const principal = await authenticate(request);
        if (principal.role !== 'admin')
            throw new DomainError(403, 'Это действие доступно администратору службы поддержки.');
    };
    if (options.configureApp) await options.configureApp(app);
    app.get('/health', { schema: { security: [] } }, async () => ({ status: 'ok' }));
    await registerIdentityRoutes(app, authenticate);
    await registerRoutes(app, logic, authenticate);
    if (options.registerFeatures) await options.registerFeatures(app, authenticate, authenticateAdmin);
    return app;
}
