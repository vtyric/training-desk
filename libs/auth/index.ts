import { JwtAccessTokenVerifier, type AccessTokenConfig } from './dal/access-token-verifier';
import { AccessTokenAuthService } from './logic/auth-service';

export type { AccessTokenConfig } from './dal/access-token-verifier';

/** Compose a resource server; student applications own their OIDC clients and browser login. */
export function createAccessTokenAuth(
    config: AccessTokenConfig,
    resolveTeam: (slug: string) => Promise<string | null>
) {
    const service = new AccessTokenAuthService(new JwtAccessTokenVerifier(config), config.audience, resolveTeam);
    return { authenticateToken: (token: string) => service.authenticateToken(token), close: async () => undefined };
}

export { KeycloakDirectory, type KeycloakDirectoryConfig, type KeycloakAssignee } from './dal/keycloak-directory';
