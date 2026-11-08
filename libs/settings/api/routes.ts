import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SettingsLogic } from '../logic/settings-logic';
import { SettingsError, type SettingsDocument } from '../types';
import { settingsDocumentSchema, settingsPatchSchema } from './settings-schema';

const revisionHeaders = {
    type: 'object',
    properties: { 'if-match': { type: 'string' } },
};

function expectedRevision(header: string | string[] | undefined): number | undefined {
    if (header === undefined) return undefined;
    if (typeof header !== 'string' || !/^"\d+"$/.test(header))
        throw new SettingsError(400, 'В заголовке If-Match укажите номер редакции в двойных кавычках, например "3"');
    const revision = Number(header.slice(1, -1));
    if (!Number.isSafeInteger(revision))
        throw new SettingsError(400, 'Не удалось прочитать номер редакции. Загрузите настройки заново');
    return revision;
}

export async function registerSettingsRoutes(
    app: FastifyInstance,
    logic: SettingsLogic,
    authenticateAdmin: (request: FastifyRequest) => Promise<void>
) {
    const send = (document: SettingsDocument, reply: FastifyReply) =>
        reply
            .header('etag', `"${document.revision}"`)
            .header('cache-control', 'no-store')
            .header('x-restart-required', String(logic.restartRequired(document)))
            .send(document);
    app.get(
        '/api/settings',
        { onRequest: authenticateAdmin, schema: { response: { 200: settingsDocumentSchema } } },
        async (_request, reply) => {
            return send(await logic.get(), reply);
        }
    );
    app.put<{ Body: unknown }>(
        '/api/settings',
        {
            onRequest: authenticateAdmin,
            schema: {
                headers: revisionHeaders,
                body: settingsDocumentSchema,
                response: { 200: settingsDocumentSchema },
            },
        },
        async (request, reply) => {
            return send(await logic.put(request.body, expectedRevision(request.headers['if-match'])), reply);
        }
    );
    app.patch<{ Body: unknown }>(
        '/api/settings',
        {
            onRequest: authenticateAdmin,
            schema: { headers: revisionHeaders, body: settingsPatchSchema, response: { 200: settingsDocumentSchema } },
        },
        async (request, reply) =>
            send(await logic.patch(request.body, expectedRevision(request.headers['if-match'])), reply)
    );
}
