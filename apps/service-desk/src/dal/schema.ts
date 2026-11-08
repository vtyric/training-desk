import { sql } from 'drizzle-orm';
import {
    bigint,
    bigserial,
    check,
    foreignKey,
    boolean,
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';

export const teams = pgTable('teams', {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique('teams_slug_key'),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
});

export const apiTokens = pgTable(
    'api_tokens',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        teamId: uuid('team_id').notNull(),
        hash: text('hash').notNull().unique('api_tokens_hash_key'),
        username: text('username').notNull(),
        role: text('role').notNull(),
        active: boolean('active').notNull().default(true),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [
        foreignKey({ name: 'api_tokens_team_id_fkey', columns: [t.teamId], foreignColumns: [teams.id] }),
        check('api_tokens_role_check', sql`${t.role} IN ('customer', 'support', 'admin')`),
    ]
);

export const users = pgTable(
    'training_users',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        teamId: uuid('team_id').notNull(),
        username: text('username').notNull(),
        displayName: text('display_name').notNull(),
        role: text('role').notNull(),
        identityExpiresAt: timestamp('identity_expires_at', { withTimezone: true }),
    },
    (t) => [
        uniqueIndex('user_team_name').on(t.teamId, t.username),
        foreignKey({ name: 'training_users_team_id_fkey', columns: [t.teamId], foreignColumns: [teams.id] }),
        check('training_users_role_check', sql`${t.role} IN ('customer', 'support', 'admin')`),
    ]
);

export const issues = pgTable(
    'issues',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        teamId: uuid('team_id').notNull(),
        requestTypeId: text('request_type_id').notNull(),
        summary: text('summary').notNull(),
        description: text('description').notNull(),
        fields: jsonb('fields').$type<Record<string, unknown>>().notNull(),
        reporter: text('reporter').notNull(),
        assignee: text('assignee'),
        assigneeDisplayName: text('assignee_display_name'),
        status: text('status').notNull().default('10005'),
        resolution: text('resolution'),
        version: integer('version').notNull().default(1),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
        index('issue_team_updated').on(t.teamId, t.updatedAt, t.id),
        foreignKey({ name: 'issues_team_id_fkey', columns: [t.teamId], foreignColumns: [teams.id] }),
    ]
);

export const comments = pgTable(
    'comments',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        issueId: bigint('issue_id', { mode: 'number' }).notNull(),
        author: text('author').notNull(),
        body: text('body').notNull(),
        public: boolean('public').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [foreignKey({ name: 'comments_issue_id_fkey', columns: [t.issueId], foreignColumns: [issues.id] })]
);

export const history = pgTable(
    'issue_history',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        issueId: bigint('issue_id', { mode: 'number' }).notNull(),
        author: text('author').notNull(),
        action: text('action').notNull(),
        data: jsonb('data').$type<Record<string, unknown>>().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [foreignKey({ name: 'issue_history_issue_id_fkey', columns: [t.issueId], foreignColumns: [issues.id] })]
);

export const subscriptions = pgTable(
    'webhook_subscriptions',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        teamId: uuid('team_id').notNull(),
        url: text('url').notNull(),
        secret: text('secret').notNull(),
        active: boolean('active').notNull().default(true),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [foreignKey({ name: 'webhook_subscriptions_team_id_fkey', columns: [t.teamId], foreignColumns: [teams.id] })]
);

export const outbox = pgTable(
    'webhook_outbox',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        teamId: uuid('team_id').notNull(),
        issueId: bigint('issue_id', { mode: 'number' }).notNull(),
        event: text('event').notNull(),
        payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
        foreignKey({ name: 'webhook_outbox_team_id_fkey', columns: [t.teamId], foreignColumns: [teams.id] }),
        foreignKey({ name: 'webhook_outbox_issue_id_fkey', columns: [t.issueId], foreignColumns: [issues.id] }),
    ]
);

export type Issue = typeof issues.$inferSelect;
