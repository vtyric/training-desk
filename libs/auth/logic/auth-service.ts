import { AuthError, type AccessTokenVerifier, type AuthPrincipal } from '../types';

/** Admission and tenant mapping are separate from token signature validation. */
export class AccessTokenAuthService {
    constructor(
        private readonly verifier: AccessTokenVerifier,
        private readonly audience: string,
        private readonly resolveTeam: (slug: string) => Promise<string | null>
    ) {}

    async authenticateToken(token: string): Promise<AuthPrincipal | null> {
        const claims = await this.verifier.verify(token);
        if (!claims) return null;
        const username = claims.preferred_username;
        const slug = claims.team_slug;
        if (
            typeof username !== 'string' ||
            !/^[A-Za-z0-9._@-]{1,128}$/.test(username) ||
            typeof slug !== 'string' ||
            !/^[a-z][a-z0-9-]{1,39}$/.test(slug)
        )
            throw new AuthError(403, 'В учётной записи не заполнены данные для входа. Обратитесь к администратору');
        const resourceAccess = claims.resource_access;
        const resource =
            resourceAccess && typeof resourceAccess === 'object' && this.audience in resourceAccess
                ? (resourceAccess as Record<string, unknown>)[this.audience]
                : null;
        const roles = resource && typeof resource === 'object' && 'roles' in resource ? resource.roles : null;
        if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string'))
            throw new AuthError(403, 'Учётной записи не выданы права доступа. Обратитесь к администратору');
        const role = roles.includes('admin')
            ? 'admin'
            : roles.includes('support')
              ? 'support'
              : roles.includes('customer')
                ? 'customer'
                : null;
        if (!role) throw new AuthError(403, 'Учётной записи не выданы права доступа. Обратитесь к администратору');
        const teamId = await this.resolveTeam(slug);
        if (!teamId) throw new AuthError(403, 'Нет доступа к службе поддержки. Обратитесь к администратору');
        return { teamId, username, role, ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}) };
    }
}
