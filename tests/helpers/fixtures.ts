import { randomBytes } from 'node:crypto';
import type { Database } from '../../apps/service-desk/src/dal/database';
import { apiTokens, teams, users } from '../../apps/service-desk/src/dal/schema';
import { hashToken } from '../../apps/service-desk/src/dal/repository';

/** Test data is prepared through DAL; setup is not part of the public Service Desk API. */
export async function createTestTeam(
    db: Database,
    input: { slug: string; name: string; support: string; customer: string }
) {
    const supportToken = randomBytes(32).toString('hex');
    const customerToken = randomBytes(32).toString('hex');
    const team = await db.transaction(async (tx) => {
        const [row] = await tx.insert(teams).values({ slug: input.slug, name: input.name }).returning();
        await tx.insert(users).values([
            { teamId: row.id, username: input.support, displayName: 'Сотрудник поддержки', role: 'support' },
            { teamId: row.id, username: input.customer, displayName: 'Заявитель', role: 'customer' },
        ]);
        await tx.insert(apiTokens).values([
            { teamId: row.id, username: input.support, hash: hashToken(supportToken), role: 'support' },
            { teamId: row.id, username: input.customer, hash: hashToken(customerToken), role: 'customer' },
        ]);
        return row;
    });
    return { team, credentials: { supportToken, customerToken } };
}
