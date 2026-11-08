import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import type { QueryDatabase } from './database';
import { apiTokens, comments, history, issues, outbox, teams, type Issue } from './schema';

export function hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
}

export class Repository {
    constructor(private readonly db: QueryDatabase) {}

    async authenticate(
        token: string
    ): Promise<{ teamId: string; username: string; role: 'customer' | 'support' | 'admin' } | null> {
        const [row] = await this.db
            .select({ token: apiTokens, team: teams })
            .from(apiTokens)
            .innerJoin(teams, eq(teams.id, apiTokens.teamId))
            .where(and(eq(apiTokens.hash, hashToken(token)), eq(apiTokens.active, true), eq(teams.active, true)));
        if (!row || (row.token.expiresAt && row.token.expiresAt <= new Date())) return null;
        const role = row.token.role;
        if (role !== 'customer' && role !== 'support' && role !== 'admin') return null;
        return { teamId: row.token.teamId, username: row.token.username, role };
    }

    async findActiveTeamSlug(teamId: string) {
        const [team] = await this.db
            .select({ slug: teams.slug })
            .from(teams)
            .where(and(eq(teams.id, teamId), eq(teams.active, true)));
        return team?.slug ?? null;
    }

    async findIssue(teamId: string, id: number) {
        const [issue] = await this.db
            .select()
            .from(issues)
            .where(and(eq(issues.teamId, teamId), eq(issues.id, id)));
        return issue;
    }

    async listRequests(
        teamId: string,
        reporter: string | undefined,
        status: 'all' | 'open' | 'closed',
        start: number,
        limit: number
    ) {
        const where = and(
            eq(issues.teamId, teamId),
            reporter === undefined ? undefined : eq(issues.reporter, reporter),
            status === 'open'
                ? isNull(issues.resolution)
                : status === 'closed'
                  ? isNotNull(issues.resolution)
                  : undefined
        );
        const [rows, totals] = await Promise.all([
            this.db
                .select()
                .from(issues)
                .where(where)
                .orderBy(desc(issues.updatedAt), desc(issues.id))
                .offset(start)
                .limit(limit),
            this.db.select({ total: count() }).from(issues).where(where),
        ]);
        return { rows, total: totals[0]?.total ?? 0 };
    }

    async createIssue(input: typeof issues.$inferInsert) {
        const [issue] = await this.db.insert(issues).values(input).returning();
        return issue;
    }

    async updateIssue(issue: Issue, changes: Partial<typeof issues.$inferInsert>) {
        const [updated] = await this.db
            .update(issues)
            .set({ ...changes, updatedAt: new Date(), version: sql`${issues.version} + 1` })
            .where(and(eq(issues.id, issue.id), eq(issues.teamId, issue.teamId), eq(issues.version, issue.version)))
            .returning();
        return updated;
    }

    async addHistory(issueId: number, author: string, action: string, data: Record<string, unknown>) {
        await this.db.insert(history).values({ issueId, author, action, data });
    }

    async addEvent(issue: Issue, event: string, payload: Record<string, unknown>) {
        await this.db.insert(outbox).values({ teamId: issue.teamId, issueId: issue.id, event, payload });
    }

    async listComments(issueId: number, publicOnly: boolean, start: number, limit: number) {
        const where = and(eq(comments.issueId, issueId), publicOnly ? eq(comments.public, true) : undefined);
        const [rows, totals] = await Promise.all([
            this.db.select().from(comments).where(where).orderBy(asc(comments.id)).offset(start).limit(limit),
            this.db.select({ total: count() }).from(comments).where(where),
        ]);
        return { rows, total: totals[0]?.total ?? 0 };
    }

    async addComment(issueId: number, author: string, body: string, isPublic: boolean) {
        const [comment] = await this.db
            .insert(comments)
            .values({ issueId, author, body, public: isPublic })
            .returning();
        return comment;
    }
}
