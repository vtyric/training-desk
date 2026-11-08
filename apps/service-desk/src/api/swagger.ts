import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { documentSwaggerRoute, swaggerTags } from './swagger-documentation';

interface SwaggerAuthSystem {
    getConfigs(): { identityLogoutUrl: string };
    authSelectors: { authorized(): { getIn(path: string[]): unknown } };
}

/** Serialized by swagger-ui: keep this browser plugin free of module closures. */
export function identityLogoutPlugin(system: SwaggerAuthSystem) {
    return {
        statePlugins: {
            auth: {
                wrapActions: {
                    logout: (original: (names: string[]) => unknown) => (names: string[]) => {
                        const idToken = system.authSelectors.authorized().getIn(['identityOAuth', 'token', 'id_token']);
                        const result = original(names);
                        if (names.includes('identityOAuth')) {
                            const browser = globalThis as unknown as {
                                location: { origin: string; assign(url: string): void };
                            };
                            const url = new URL(system.getConfigs().identityLogoutUrl);
                            url.searchParams.set('client_id', 'service-desk-swagger');
                            url.searchParams.set('post_logout_redirect_uri', `${browser.location.origin}/docs/`);
                            if (typeof idToken === 'string') url.searchParams.set('id_token_hint', idToken);
                            browser.location.assign(url.toString());
                        }
                        return result;
                    },
                },
            },
        },
    };
}

export async function registerSwagger(app: FastifyInstance, name: string, issuerUrl: string) {
    const issuer = issuerUrl.replace(/\/$/, '');
    await app.register(swagger, {
        transform: documentSwaggerRoute,
        openapi: {
            tags: swaggerTags,
            info: {
                title: name,
                version: '0.2.0',
                description:
                    'Нажмите Authorize, чтобы войти. Права зависят от роли: заявитель, сотрудник поддержки или администратор службы поддержки. Чтобы сменить пользователя, сначала нажмите Logout.',
            },
            security: [{ identityOAuth: [] }],
            components: {
                securitySchemes: {
                    identityOAuth: {
                        type: 'oauth2',
                        description: 'Вход в службу поддержки. Используйте свою учётную запись.',
                        flows: {
                            authorizationCode: {
                                authorizationUrl: `${issuer}/protocol/openid-connect/auth`,
                                tokenUrl: `${issuer}/protocol/openid-connect/token`,
                                scopes: { openid: 'Вход', profile: 'Профиль', email: 'Email' },
                            },
                        },
                    },
                },
            },
        },
    });
    await app.register(swaggerUi, {
        routePrefix: '/docs',
        uiConfig: {
            persistAuthorization: false,
            docExpansion: 'none',
            displayRequestDuration: true,
            plugins: [identityLogoutPlugin],
            ...{ identityLogoutUrl: `${issuer}/protocol/openid-connect/logout` },
        },
        initOAuth: {
            clientId: 'service-desk-swagger',
            appName: 'API службы поддержки',
            scopes: ['openid', 'profile', 'email'],
            usePkceWithAuthorizationCodeGrant: true,
        },
    });
}
