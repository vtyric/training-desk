import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDatabase } from './database';
import { hashToken } from './repository';
import { apiTokens, teams, users } from './schema';

export async function seedDatabase(url: string) {
    const { db, close } = createDatabase(url);
    try {
        const [existing] = await db.select().from(teams).where(eq(teams.slug, 'demo'));
        if (existing) {
            console.log('Service Desk already exists; credentials preserved.');
            return;
        }
        const supportToken = process.env['TEAM_API_TOKEN'] ?? randomBytes(32).toString('hex');
        const customerToken = process.env['CUSTOMER_API_TOKEN'] ?? randomBytes(32).toString('hex');
        if (supportToken.length < 32 || customerToken.length < 32 || supportToken === customerToken)
            throw new Error('Seed tokens must be distinct and at least 32 characters');
        const team = await db.transaction(async (tx) => {
            const [row] = await tx.insert(teams).values({ slug: 'demo', name: 'Учебная команда' }).returning();
            await tx.insert(users).values([
                { teamId: row.id, username: 'alice', displayName: 'Алиса, заявитель', role: 'customer' },
                { teamId: row.id, username: 'support', displayName: 'Сотрудник поддержки', role: 'support' },
            ]);
            await tx.insert(apiTokens).values([
                { teamId: row.id, hash: hashToken(supportToken), username: 'support', role: 'support' },
                { teamId: row.id, hash: hashToken(customerToken), username: 'alice', role: 'customer' },
            ]);
            return row;
        });
        console.log(
            JSON.stringify(
                {
                    teamId: team.id,
                    slug: team.slug,
                    ...(!process.env['TEAM_API_TOKEN'] ? { supportToken } : {}),
                    ...(!process.env['CUSTOMER_API_TOKEN'] ? { customerToken } : {}),
                },
                null,
                2
            )
        );
    } finally {
        await close();
    }
}

if (/\/seed\.(ts|js|cjs)$/.test(process.argv[1] ?? '')) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required');
    seedDatabase(url).catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
