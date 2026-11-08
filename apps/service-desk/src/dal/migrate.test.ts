import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { migrateDatabase } from './migrate';

test(
    'SQL migrations apply in order, are idempotent, and reject edited/missing history',
    { skip: !process.env['DATABASE_URL'] },
    async () => {
        const sourceUrl = process.env['DATABASE_URL'];
        assert.ok(sourceUrl);
        const admin = postgres(sourceUrl, { max: 1 });
        const name = `migration_test_${randomUUID().replaceAll('-', '')}`;
        const directory = await mkdtemp(join(tmpdir(), 'training-migrations-'));
        const url = new URL(sourceUrl);
        url.pathname = `/${name}`;
        let inspect: ReturnType<typeof postgres> | undefined;
        try {
            await admin.unsafe(`CREATE DATABASE "${name}"`);
            const baseline = await readFile('apps/service-desk/src/dal/migrations/0000_initial.sql', 'utf8');
            await writeFile(join(directory, '0000_initial.sql'), baseline);
            await writeFile(join(directory, '0001_add_field.sql'), 'ALTER TABLE teams ADD COLUMN test_marker text;');
            await migrateDatabase(url.toString(), directory);
            await migrateDatabase(url.toString(), directory);
            inspect = postgres(url.toString(), { max: 1 });
            const applied = await inspect<{ name: string }[]>`SELECT name FROM training_migrations ORDER BY name`;
            assert.deepEqual(
                applied.map((entry) => entry.name),
                ['0000_initial', '0001_add_field']
            );
            const columns =
                await inspect`SELECT column_name FROM information_schema.columns WHERE table_name = 'teams' AND column_name = 'test_marker'`;
            assert.equal(columns.length, 1);
            await writeFile(join(directory, '0001_add_field.sql'), 'SELECT 1;');
            await assert.rejects(migrateDatabase(url.toString(), directory), /changed after being applied/);
            await rm(join(directory, '0001_add_field.sql'));
            await assert.rejects(migrateDatabase(url.toString(), directory), /is missing/);
        } finally {
            if (inspect) await inspect.end();
            await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
            await admin.end();
            await rm(directory, { recursive: true, force: true });
        }
    }
);
