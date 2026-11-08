export interface GlobalSettings {
    security: { allowLegacyApiTokens: boolean };
    server: { host: string; port: number; bodyLimit: number };
    database: { urlEnv: string; poolMax: number };
    identity: {
        issuerUrlEnv: string;
        internalIssuerUrlEnv: string;
        audience: string;
        allowInsecureLocal: boolean;
        directoryClientId: string;
        directoryClientSecretEnv: string;
        directoryTimeoutMs: number;
    };
    service: { name: string; projectKey: string; serviceDeskId: string };
    webhooks: { pollIntervalMs: number; timeoutMs: number; batchSize: number; retryDelaysMs: number[] };
    ui: { enabled: boolean; publicClientId: string; realm: string; identityUrlEnv: string };
}
export interface TeamWebhook {
    id: string;
    url: string;
    enabled: boolean;
    createdAt: string;
}
export interface SettingsDocument extends GlobalSettings {
    version: 1;
    revision: number;
    teams: Record<string, { webhook: TeamWebhook }>;
}
export class SettingsError extends Error {
    constructor(
        public readonly statusCode: number,
        message: string
    ) {
        super(message);
    }
}
