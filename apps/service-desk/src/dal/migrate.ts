import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';

/** Apply ordered SQL migrations once and reject edits or removal of already-applied migrations. */
export async function migrateDatabase(url: string, directory = resolve('apps/service-desk/src/dal/migrations')) {
    const client = postgres(url, { max: 1 });
    try {
        const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-zA-Z0-9_-]+\.sql$/.test(name)).sort();
        if (!names.length) throw new Error('No SQL migrations found');
        const migrations = await Promise.all(
            names.map(async (filename) => {
                const body = await readFile(resolve(directory, filename), 'utf8');
                return { name: filename.slice(0, -4), body, checksum: createHash('sha256').update(body).digest('hex') };
            })
        );
        if (new Set(names.map((name) => name.slice(0, 4))).size !== names.length)
            throw new Error('Migration number must be unique');
        // Serialize the complete upgrade so concurrent application starts cannot interleave migration order.
        await client.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(7918462)`;
            await tx`CREATE TABLE IF NOT EXISTS training_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
            const applied = await tx<
                { name: string; checksum: string }[]
            >`SELECT name, checksum FROM training_migrations ORDER BY name`;
            for (const existing of applied) {
                const migration = migrations.find((entry) => entry.name === existing.name);
                if (!migration) throw new Error(`Applied migration ${existing.name} is missing`);
                if (migration.checksum !== existing.checksum)
                    throw new Error(`Migration ${existing.name} changed after being applied`);
            }
            const latestApplied = applied.at(-1)?.name;
            for (const migration of migrations) {
                if (applied.some((entry) => entry.name === migration.name)) continue;
                if (latestApplied && migration.name < latestApplied)
                    throw new Error(`Migration ${migration.name} was inserted before an applied migration`);
                await tx.unsafe(migration.body);
                await tx`INSERT INTO training_migrations (name, checksum) VALUES (${migration.name}, ${migration.checksum})`;
            }
        });
    } finally {
        await client.end();
    }
}

if (/\/migrate\.(ts|js|cjs)$/.test(process.argv[1] ?? '')) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required');
    migrateDatabase(url).catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
