import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requestFields } from '../logic/catalog';
import type { RequestLogic, RequestListInput } from '../logic/requests';
import { DomainError, type CreateRequest, type Principal } from '../logic/types';

export type Authenticate = (request: FastifyRequest) => Promise<Principal>;
const string = { type: 'string', minLength: 1, maxLength: 20000 };
const pageSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        start: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    },
};
type Page = { start: number; limit: number };
type Key = { key: string };

export async function registerRoutes(app: FastifyInstance, logic: RequestLogic, authenticate: Authenticate) {
    const desk = (id: string) => {
        if (id !== '3') throw new DomainError(404, 'Служба поддержки не найдена');
    };

    app.get<{ Params: { deskId: string; typeId: string } }>(
        '/rest/servicedeskapi/servicedesk/:deskId/requesttype/:typeId/field',
        async (request) => {
            await authenticate(request);
            desk(request.params.deskId);
            return {
                requestTypeFields: requestFields(request.params.typeId),
                canRaiseOnBehalfOf: false,
                canAddRequestParticipants: false,
            };
        }
    );

    app.get<{ Querystring: RequestListInput }>(
        '/rest/servicedeskapi/request',
        {
            schema: {
                querystring: {
                    ...pageSchema,
                    properties: {
                        ...pageSchema.properties,
                        start: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
                        requestStatus: {
                            type: 'string',
                            enum: ['ALL_REQUESTS', 'OPEN_REQUESTS', 'CLOSED_REQUESTS'],
                            default: 'ALL_REQUESTS',
                        },
                    },
                },
            },
        },
        async (request) => logic.listRequests(await authenticate(request), request.query)
    );

    app.post<{ Body: CreateRequest }>(
        '/rest/servicedeskapi/request',
        {
            schema: {
                body: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['serviceDeskId', 'requestTypeId', 'requestFieldValues'],
                    properties: {
                        serviceDeskId: string,
                        requestTypeId: string,
                        requestFieldValues: { type: 'object', additionalProperties: true, maxProperties: 10 },
                        requestParticipants: { type: 'array', maxItems: 20, items: string },
                        raiseOnBehalfOf: string,
                    },
                },
            },
        },
        async (request, reply) => reply.code(201).send(await logic.create(await authenticate(request), request.body))
    );

    app.get<{ Params: Key }>('/rest/servicedeskapi/request/:key', async (request) =>
        logic.request(await authenticate(request), request.params.key)
    );
    app.get<{ Querystring: { username?: string; issueKey?: string; project?: string; maxResults: number } }>(
        '/rest/api/2/user/assignable/search',
        {
            schema: {
                querystring: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        username: { type: 'string', maxLength: 128 },
                        issueKey: { type: 'string', minLength: 1, maxLength: 128 },
                        project: { type: 'string', minLength: 1, maxLength: 128 },
                        maxResults: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
                    },
                },
            },
        },
        async (request) => logic.assignableUsers(await authenticate(request), request.query)
    );
    app.put<{ Params: Key; Body: { name: string | null } }>(
        '/rest/api/2/issue/:key/assignee',
        {
            schema: {
                body: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name'],
                    properties: {
                        name: { anyOf: [{ type: 'string', minLength: 1, maxLength: 128 }, { type: 'null' }] },
                    },
                },
            },
        },
        async (request, reply) => {
            await logic.assign(await authenticate(request), request.params.key, request.body.name);
            return reply.code(204).send();
        }
    );

    app.get<{ Params: Key; Querystring: { expand?: string } }>(
        '/rest/api/2/issue/:key/transitions',
        {
            schema: {
                querystring: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { expand: { type: 'string', enum: ['transitions.fields'] } },
                },
            },
        },
        async (request) =>
            logic.transitions(
                await authenticate(request),
                request.params.key,
                request.query.expand === 'transitions.fields'
            )
    );

    app.post<{ Params: Key; Body: { transition: { id: string }; fields?: { resolution?: { id: string } } } }>(
        '/rest/api/2/issue/:key/transitions',
        {
            schema: {
                body: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['transition'],
                    properties: {
                        transition: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['id'],
                            properties: { id: string },
                        },
                        fields: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                resolution: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['id'],
                                    properties: { id: string },
                                },
                            },
                        },
                    },
                },
            },
        },
        async (request, reply) => {
            await logic.transition(await authenticate(request), request.params.key, request.body);
            return reply.code(204).send();
        }
    );

    app.get<{ Params: Key; Querystring: Page }>(
        '/rest/servicedeskapi/request/:key/comment',
        { schema: { querystring: pageSchema } },
        async (request) => logic.listComments(await authenticate(request), request.params.key, request.query)
    );
    app.post<{ Params: Key; Body: { body: string; public: boolean } }>(
        '/rest/servicedeskapi/request/:key/comment',
        {
            schema: {
                body: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['body', 'public'],
                    properties: { body: string, public: { type: 'boolean' } },
                },
            },
        },
        async (request, reply) =>
            reply
                .code(201)
                .send(
                    await logic.comment(
                        await authenticate(request),
                        request.params.key,
                        request.body.body,
                        request.body.public
                    )
                )
    );
}
