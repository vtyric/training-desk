import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
type RemoteJWKSet = ReturnType<typeof createRemoteJWKSet>;
import { AuthError, type AccessTokenVerifier, type VerifiedAccessClaims } from '../types';

export interface AccessTokenConfig {
    issuerUrl: string;
    internalIssuerUrl?: string;
    audience: string;
    allowInsecureLocal?: boolean;
}

/** Public issuer remains immutable even when outbound server requests use the internal Docker address. */
export function issuerUrl(raw: string, allowInsecureLocal: boolean, internal = false): URL {
    const url = new URL(raw);
    const hosts = internal
        ? ['localhost', '127.0.0.1', '[::1]', 'identity', 'host.docker.internal']
        : ['localhost', '127.0.0.1', '[::1]'];
    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(url.protocol === 'https:' || (allowInsecureLocal && url.protocol === 'http:' && hosts.includes(url.hostname)))
    ) {
        throw new Error(
            'Identity issuer requires HTTPS; HTTP is allowed only for explicitly enabled local development'
        );
    }
    url.pathname = url.pathname.replace(/\/$/, '');
    return url;
}

/** Verify access JWTs against trusted discovery/JWKS; no cookies, passwords, client secret or token issuance. */
export class JwtAccessTokenVerifier implements AccessTokenVerifier {
    private readonly issuer: URL;
    private readonly internal: URL | undefined;
    private keys?: Promise<RemoteJWKSet>;
    constructor(private readonly config: AccessTokenConfig) {
        this.issuer = issuerUrl(config.issuerUrl, config.allowInsecureLocal ?? false);
        this.internal = config.internalIssuerUrl
            ? issuerUrl(config.internalIssuerUrl, config.allowInsecureLocal ?? false, true)
            : undefined;
        if (!config.audience.trim()) throw new Error('OIDC audience is required');
    }

    private target(raw: string): URL {
        const url = new URL(raw);
        if (
            url.origin !== this.issuer.origin ||
            !url.pathname.startsWith(`${this.issuer.pathname}/`) ||
            url.username ||
            url.password ||
            url.hash
        )
            throw new Error('Identity endpoint is outside the configured issuer');
        if (this.internal) {
            url.pathname = `${this.internal.pathname}${url.pathname.slice(this.issuer.pathname.length)}`;
            url.protocol = this.internal.protocol;
            url.host = this.internal.host;
        }
        return url;
    }

    private async remoteKeys(): Promise<RemoteJWKSet> {
        if (!this.keys) {
            this.keys = (async () => {
                const metadataUrl = `${this.issuer.href}/.well-known/openid-configuration`;
                const response = await fetch(this.target(metadataUrl), {
                    redirect: 'error',
                    signal: AbortSignal.timeout(10_000),
                });
                if (!response.ok) throw new Error('Identity discovery failed');
                const metadata: unknown = await response.json();
                if (
                    !metadata ||
                    typeof metadata !== 'object' ||
                    !('issuer' in metadata) ||
                    metadata.issuer !== this.issuer.href ||
                    !('jwks_uri' in metadata) ||
                    typeof metadata.jwks_uri !== 'string'
                )
                    throw new Error('Invalid identity discovery');
                this.target(metadata.jwks_uri);
                return createRemoteJWKSet(new URL(metadata.jwks_uri), {
                    timeoutDuration: 10_000,
                    cooldownDuration: 30_000,
                    cacheMaxAge: 300_000,
                    [customFetch]: (url, options) =>
                        fetch(this.target(url), {
                            ...options,
                            redirect: 'error',
                            signal: options.signal
                                ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
                                : AbortSignal.timeout(10_000),
                        }),
                });
            })().catch(() => {
                this.keys = undefined;
                throw new AuthError(503, 'Не удалось проверить вход. Повторите попытку позже');
            });
        }
        return this.keys;
    }

    async verify(token: string): Promise<VerifiedAccessClaims | null> {
        if (token.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
        try {
            const { payload } = await jwtVerify(token, await this.remoteKeys(), {
                issuer: this.issuer.href,
                audience: this.config.audience,
                algorithms: ['RS256'],
                requiredClaims: ['exp', 'iat', 'sub'],
            });
            if (payload['typ'] !== 'Bearer' || typeof payload.sub !== 'string' || !payload.sub) return null;
            return {
                sub: payload.sub,
                exp: payload.exp,
                preferred_username: payload['preferred_username'],
                team_slug: payload['team_slug'],
                resource_access: payload['resource_access'],
            };
        } catch (error) {
            if (error instanceof AuthError) throw error;
            if (
                error instanceof errors.JOSEError &&
                !(error instanceof errors.JWKSTimeout) &&
                !(error instanceof errors.JWKSInvalid)
            )
                return null;
            throw new AuthError(503, 'Не удалось проверить вход. Повторите попытку позже');
        }
    }
}
