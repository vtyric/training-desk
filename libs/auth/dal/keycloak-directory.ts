import { AuthError } from '../types';
import { issuerUrl } from './access-token-verifier';

export interface KeycloakAssignee {
    username: string;
    displayName: string;
}

export interface KeycloakDirectoryConfig {
    issuerUrl: string;
    internalIssuerUrl?: string;
    resourceClientId: string;
    clientId: string;
    clientSecret: string;
    allowInsecureLocal?: boolean;
    timeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
type CachedToken = { value: string; expiresAt: number };
const pageSize = 100;
const maxPages = 100;
const unavailable = () => new AuthError(503, 'Не удалось загрузить сотрудников. Повторите попытку позже');
const object = (value: unknown): value is JsonObject =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value));
const segment = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw unavailable();
    return encodeURIComponent(value);
};
function realmParts(url: URL) {
    const match = /^(.*)\/realms\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (!match) throw new Error('Identity directory requires a realm issuer URL');
    return { prefix: match[1], realm: match[2] };
}

/** Read-only Keycloak Admin API adapter. Credentials and cached tokens never leave the server. */
export class KeycloakDirectory {
    private readonly tokenUrl: URL;
    private readonly adminUrl: URL;
    private readonly timeoutMs: number;
    private token?: Promise<CachedToken>;

    constructor(private readonly config: KeycloakDirectoryConfig) {
        const issuer = issuerUrl(config.issuerUrl, config.allowInsecureLocal ?? false);
        const target = config.internalIssuerUrl
            ? issuerUrl(config.internalIssuerUrl, config.allowInsecureLocal ?? false, true)
            : issuer;
        const publicParts = realmParts(issuer);
        const targetParts = realmParts(target);
        if (publicParts.realm !== targetParts.realm) throw new Error('Identity directory realm must match issuer');
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.resourceClientId) || !config.clientId.trim() || !config.clientSecret)
            throw new Error('Identity directory client must be configured');
        this.timeoutMs = config.timeoutMs ?? 10_000;
        if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
            throw new Error('Invalid Identity directory timeout');
        this.tokenUrl = new URL(`${target.pathname}/protocol/openid-connect/token`, target.origin);
        this.adminUrl = new URL(`${targetParts.prefix}/admin/realms/${targetParts.realm}/`, target.origin);
    }

    private async serviceToken(): Promise<CachedToken> {
        if (this.token) {
            const cached = await this.token;
            if (cached.expiresAt > Date.now()) return cached;
            this.token = undefined;
        }
        this.token = (async () => {
            const response = await fetch(this.tokenUrl, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(this.timeoutMs),
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: this.config.clientId,
                    client_secret: this.config.clientSecret,
                }),
            });
            if (!response.ok) throw unavailable();
            const body: unknown = await response.json();
            if (
                !object(body) ||
                typeof body['access_token'] !== 'string' ||
                !body['access_token'] ||
                body['access_token'].length > 32768 ||
                typeof body['expires_in'] !== 'number' ||
                !Number.isFinite(body['expires_in']) ||
                body['expires_in'] <= 0 ||
                (body['token_type'] !== undefined && String(body['token_type']).toLowerCase() !== 'bearer')
            )
                throw unavailable();
            return {
                value: body['access_token'],
                expiresAt: Date.now() + Math.max(0, body['expires_in'] * 1000 - 10_000),
            };
        })().catch(() => {
            this.token = undefined;
            throw unavailable();
        });
        return this.token;
    }

    private async get(path: string, query?: Record<string, string>, retry = true): Promise<unknown> {
        try {
            const url = new URL(path, this.adminUrl);
            if (url.origin !== this.adminUrl.origin || !url.pathname.startsWith(this.adminUrl.pathname))
                throw unavailable();
            if (query) url.search = new URLSearchParams(query).toString();
            const token = await this.serviceToken();
            const response = await fetch(url, {
                redirect: 'error',
                signal: AbortSignal.timeout(this.timeoutMs),
                headers: { authorization: `Bearer ${token.value}` },
            });
            if (response.status === 401 && retry) {
                this.token = undefined;
                return await this.get(path, query, false);
            }
            if (!response.ok) throw unavailable();
            return await response.json();
        } catch {
            throw unavailable();
        }
    }

    private async resourceId(): Promise<string> {
        const clients = await this.get('clients', { clientId: this.config.resourceClientId });
        if (!Array.isArray(clients)) throw unavailable();
        const matches = clients.filter(
            (client): client is JsonObject => object(client) && client['clientId'] === this.config.resourceClientId
        );
        if (matches.length !== 1) throw unavailable();
        return segment(matches[0]['id']);
    }

    private async eligible(
        user: JsonObject,
        teamSlug: string,
        resourceId: string,
        requiredRoles: readonly string[] = ['support', 'admin']
    ): Promise<KeycloakAssignee | null> {
        const username = user['username'];
        if (
            user['enabled'] !== true ||
            typeof username !== 'string' ||
            !/^[A-Za-z0-9._@-]{1,128}$/.test(username) ||
            username.startsWith('service-account-') ||
            user['serviceAccountClientId']
        )
            return null;
        const attributes = user['attributes'];
        const team = object(attributes) ? attributes['team_slug'] : undefined;
        if (!Array.isArray(team) || team.length !== 1 || team[0] !== teamSlug) return null;
        const roles = await this.get(`users/${segment(user['id'])}/role-mappings/clients/${resourceId}/composite`);
        if (!Array.isArray(roles) || !roles.every((role) => object(role) && typeof role['name'] === 'string'))
            throw unavailable();
        if (!roles.some((role) => requiredRoles.includes(role.name))) return null;
        const fullName = [user['firstName'], user['lastName']]
            .filter((value) => typeof value === 'string' && value.trim())
            .join(' ');
        return { username, displayName: fullName || username };
    }

    listEligible(teamSlug: string): Promise<KeycloakAssignee[]> {
        return this.collectEligible(teamSlug, ['support', 'admin']);
    }

    /** Default routing is a policy, never an arbitrary first element of the assignee list. */
    async getDefaultAssignee(teamSlug: string): Promise<KeycloakAssignee> {
        const leaders = await this.collectEligible(teamSlug, ['support-lead']);
        if (leaders.length === 0)
            throw new AuthError(503, 'Руководитель поддержки не назначен или отключён. Обратитесь к администратору');
        if (leaders.length !== 1)
            throw new AuthError(
                503,
                'Назначено несколько руководителей поддержки. Администратору нужно оставить одного'
            );
        return leaders[0];
    }

    private async collectEligible(teamSlug: string, requiredRoles: readonly string[]): Promise<KeycloakAssignee[]> {
        if (!/^[a-z][a-z0-9-]{1,39}$/.test(teamSlug)) throw unavailable();
        const resourceId = await this.resourceId();
        const found = new Map<string, KeycloakAssignee>();
        for (let page = 0; page < maxPages; page++) {
            const users = await this.get('users', {
                first: String(page * pageSize),
                max: String(pageSize),
                briefRepresentation: 'false',
            });
            if (!Array.isArray(users) || !users.every(object) || users.length > pageSize) throw unavailable();
            for (const user of users) {
                const candidate = await this.eligible(user, teamSlug, resourceId, requiredRoles);
                if (candidate) found.set(candidate.username, candidate);
            }
            if (users.length < pageSize)
                return [...found.values()].sort(
                    (a, b) => a.displayName.localeCompare(b.displayName, 'ru') || a.username.localeCompare(b.username)
                );
        }
        // Fail instead of returning a silently truncated directory.
        throw unavailable();
    }

    async findEligible(teamSlug: string, username: string): Promise<KeycloakAssignee | null> {
        if (!/^[a-z][a-z0-9-]{1,39}$/.test(teamSlug)) throw unavailable();
        if (!/^[A-Za-z0-9._@-]{1,128}$/.test(username)) return null;
        const users = await this.get('users', { username, exact: 'true', max: '2', briefRepresentation: 'false' });
        if (!Array.isArray(users) || !users.every(object)) throw unavailable();
        const matches = users.filter((user) => user['username'] === username);
        if (matches.length > 1) throw unavailable();
        if (!matches.length) return null;
        // Re-read the full user and effective role mappings for every assignment.
        const user = await this.get(`users/${segment(matches[0]['id'])}`);
        if (!object(user) || user['username'] !== username) throw unavailable();
        return this.eligible(user, teamSlug, await this.resourceId());
    }
}
