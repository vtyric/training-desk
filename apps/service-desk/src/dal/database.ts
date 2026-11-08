import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDatabase(url: string, max = 10) {
    const client = postgres(url, { max });
    return { db: drizzle(client, { schema }), close: () => client.end() };
}

export type Database = ReturnType<typeof createDatabase>['db'];
export type QueryDatabase = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;
