import postgres from 'postgres';

export interface Delivery {
    id: string;
    event_id: string;
    subscription_id: string;
    team_id: string;
    attempt: number;
    url: string;
    secret: string;
    payload: Record<string, unknown>;
}

/** Durable leases and unique event/subscription pairs support restart-safe delivery. */
export class DeliveryStore {
    private readonly sql;
    constructor(databaseUrl: string) {
        this.sql = postgres(databaseUrl, { max: 2 });
    }

    async initialize() {
        await this.sql`
            CREATE TABLE IF NOT EXISTS webhook_deliveries (
                id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES webhook_outbox(id),
                subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id),
                attempt integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'pending',
                next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
                last_status integer, last_error text, updated_at timestamptz NOT NULL DEFAULT now(),
                UNIQUE(event_id, subscription_id)
            )`;
        await this.sql`CREATE INDEX IF NOT EXISTS delivery_pending ON webhook_deliveries(state, next_attempt_at)`;
    }

    async projectSettings(
        entries: Record<string, { webhook: { id: string; url: string; enabled: boolean; createdAt: string } }>,
        secretForTeam: (teamId: string) => string
    ) {
        await this.sql.begin(async (sql) => {
            // Managed subscriptions use the stable team ID. Do not remove history or unrelated rows.
            await sql`UPDATE webhook_subscriptions SET active=false
              WHERE id=team_id AND NOT (team_id = ANY(${sql.array(Object.keys(entries))}::uuid[]))`;
            for (const [teamId, { webhook }] of Object.entries(entries)) {
                await sql`INSERT INTO webhook_subscriptions(id,team_id,url,secret,active,created_at)
                  SELECT ${webhook.id}::uuid,${teamId}::uuid,${webhook.url},${secretForTeam(teamId)},${webhook.enabled},${webhook.createdAt}::timestamptz
                  WHERE EXISTS(SELECT 1 FROM teams WHERE id=${teamId}::uuid)
                  ON CONFLICT(id) DO UPDATE SET url=EXCLUDED.url,active=EXCLUDED.active,secret=EXCLUDED.secret`;
            }
        });
    }

    async prepare() {
        await this.sql`
            INSERT INTO webhook_deliveries(id, event_id, subscription_id)
            SELECT gen_random_uuid(), e.id, s.id FROM webhook_outbox e
            JOIN webhook_subscriptions s ON s.team_id = e.team_id AND s.active AND e.created_at >= s.created_at
            ON CONFLICT(event_id, subscription_id) DO NOTHING`;
    }

    async claim(): Promise<Delivery | undefined> {
        const rows = await this.sql<Delivery[]>`
            WITH candidate AS (
                SELECT d.id FROM webhook_deliveries d
                JOIN webhook_subscriptions s ON s.id = d.subscription_id AND s.active
                JOIN teams t ON t.id = s.team_id AND t.active
                WHERE (d.state = 'pending' AND d.next_attempt_at <= now())
                   OR (d.state = 'sending' AND d.lease_until < now())
                ORDER BY d.next_attempt_at FOR UPDATE OF d SKIP LOCKED LIMIT 1
            ), claimed AS (
                UPDATE webhook_deliveries d SET state = 'sending', lease_until = now() + interval '30 seconds',
                    attempt = attempt + 1, updated_at = now()
                FROM candidate c WHERE d.id = c.id RETURNING d.*
            ) SELECT c.id, c.event_id, c.subscription_id, c.attempt, e.team_id, e.payload, s.url, s.secret
            FROM claimed c JOIN webhook_outbox e ON e.id = c.event_id
            JOIN webhook_subscriptions s ON s.id = c.subscription_id`;
        return rows[0];
    }

    async finish(id: string, state: string, status: number | null, error: string | null, delayMs: number) {
        await this.sql`UPDATE webhook_deliveries SET state = ${state}, last_status = ${status},
            last_error = ${error}, lease_until = NULL,
            next_attempt_at = now() + ${delayMs} * interval '1 millisecond', updated_at = now() WHERE id = ${id}`;
    }

    async list(teamId: string) {
        return this.sql`SELECT d.id, d.event_id, d.subscription_id, d.attempt, d.state, d.last_status, d.last_error,
            d.next_attempt_at, d.updated_at FROM webhook_deliveries d
            JOIN webhook_outbox e ON e.id = d.event_id WHERE e.team_id = ${teamId}
            ORDER BY d.updated_at DESC LIMIT 100`;
    }

    async retry(teamId: string, id: string) {
        const rows = await this.sql`UPDATE webhook_deliveries d SET state = 'pending', attempt = 0,
            next_attempt_at = now(), last_error = NULL WHERE d.id = ${id}::uuid AND d.state != 'sending'
            AND EXISTS(SELECT 1 FROM webhook_outbox e WHERE e.id = d.event_id AND e.team_id = ${teamId}) RETURNING d.id`;
        return rows.length > 0;
    }

    close() {
        return this.sql.end();
    }
}
