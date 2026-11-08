export interface AuthPrincipal {
    teamId: string;
    username: string;
    role: 'customer' | 'support' | 'admin';
    expiresAt?: number;
}

export class AuthError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string
    ) {
        super(message);
    }
}

/** Only the DAL JWT verifier may produce this identity payload after cryptographic verification. */
export interface VerifiedAccessClaims {
    sub: string;
    exp?: number;
    preferred_username?: unknown;
    team_slug?: unknown;
    resource_access?: unknown;
}

export interface AccessTokenVerifier {
    verify(token: string): Promise<VerifiedAccessClaims | null>;
}
