import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv.includes('--apply')) {
    console.log(
        'Plan: prepare identity role/schema in shared PostgreSQL/training; migrate legacy Identity data with backups if present.'
    );
    console.log('Apply: node --env-file=.env tools/migrate-identity-database.mjs --apply');
    process.exit(0);
}
if (!process.env.IDENTITY_DB_PASSWORD) throw new Error('IDENTITY_DB_PASSWORD is required');
const docker = (args, options = {}) =>
    execFileSync('docker', args, { cwd: root, maxBuffer: 128 * 1024 * 1024, ...options });
const capture = (args) => docker(args, { encoding: 'utf8' }).trim();
const config = JSON.parse(capture(['compose', 'config', '--format', 'json']));
const target = capture(['compose', 'ps', '-q', 'postgres']);
if (!target) throw new Error('Start shared postgres first: docker compose up -d --wait postgres');
const findService = (name) =>
    capture([
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${config.name}`,
        '--filter',
        `label=com.docker.compose.service=${name}`,
    ])
        .split('\n')
        .filter(Boolean);
const legacyContainers = findService('identity-db');
if (legacyContainers.length > 1)
    throw new Error('More than one legacy Identity DB container found; review migration source');
const legacy = legacyContainers[0];
const sql = (container, database, user, query) =>
    docker(['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-U', user, '-d', database], {
        input: query,
        encoding: 'utf8',
    }).trim();
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const identityTables = Number(
    sql(target, 'training', 'training', "SELECT count(*) FROM information_schema.tables WHERE table_schema='identity';")
);
if (!Number.isFinite(identityTables)) throw new Error('Cannot inspect target Identity schema');
if (identityTables > 0) {
    const marker = sql(
        target,
        'training',
        'training',
        "SELECT obj_description(oid, 'pg_namespace') FROM pg_namespace WHERE nspname='identity';"
    );
    if (marker !== 'training-desk:shared-identity:v1')
        throw new Error(
            'Identity target has existing tables without a completed migration marker; manual review required'
        );
    const realms = sql(target, 'training', 'training', 'SELECT count(*) FROM identity.realm;');
    if (Number(realms) < 1)
        throw new Error('Target Identity schema is populated but has no realms; manual review required');
    console.log('Shared Identity schema already contains realms; existing data/passwords were not changed.');
    process.exit(0);
}
const roleExists =
    sql(target, 'training', 'training', "SELECT count(*) FROM pg_roles WHERE rolname='identity';") === '1';
if (!roleExists)
    sql(
        target,
        'training',
        'training',
        `CREATE ROLE identity LOGIN PASSWORD ${quote(process.env.IDENTITY_DB_PASSWORD)};`
    );
sql(
    target,
    'training',
    'training',
    'ALTER ROLE identity IN DATABASE training SET search_path TO identity; REVOKE CREATE ON SCHEMA public FROM PUBLIC;'
);
if (!legacy) {
    sql(
        target,
        'training',
        'training',
        "CREATE SCHEMA IF NOT EXISTS identity AUTHORIZATION identity; COMMENT ON SCHEMA identity IS 'training-desk:shared-identity:v1';"
    );
    console.log(
        'Shared database ready: public Service Desk tables and identity Keycloak schema. No legacy container found.'
    );
    process.exit(0);
}
const legacyRunning = capture(['inspect', '-f', '{{.State.Running}}', legacy]) === 'true';
if (!legacyRunning)
    throw new Error(
        'Legacy Identity DB is stopped. Start its existing container before migration; no data was overwritten.'
    );
const identityContainers = findService('identity');
const runningIdentity = identityContainers.filter(
    (container) => capture(['inspect', '-f', '{{.State.Running}}', container]) === 'true'
);
const backupDir = resolve(root, '.local/backups', `identity-shared-${Date.now()}`);
await mkdir(backupDir, { recursive: true, mode: 0o700 });
await chmod(backupDir, 0o700);
const dump = (container, database, user, extra = []) =>
    docker([
        'exec',
        container,
        'pg_dump',
        '-Fc',
        '--no-owner',
        '--no-privileges',
        '-U',
        user,
        '-d',
        database,
        ...extra,
    ]);
const save = async (name, data) => writeFile(resolve(backupDir, name), data, { mode: 0o600, flag: 'wx' });
const tempDb = `identity_transfer_${randomBytes(6).toString('hex')}`;
let tempCreated = false;
let grantedCreate = false;
try {
    for (const container of runningIdentity) docker(['stop', container], { stdio: 'ignore' });
    await save('identity-original.dump', dump(legacy, 'identity', 'identity'));
    await save('service-desk-before.dump', dump(target, 'training', 'training'));
    // Copy the legacy DB while Keycloak is stopped. Rename only this private temporary copy.
    sql(legacy, 'postgres', 'identity', `CREATE DATABASE "${tempDb}" TEMPLATE identity OWNER identity;`);
    tempCreated = true;
    sql(legacy, tempDb, 'identity', 'ALTER SCHEMA public RENAME TO identity;');
    const migrated = dump(legacy, tempDb, 'identity', ['--schema=identity']);
    await save('identity-schema.dump', migrated);
    sql(
        target,
        'training',
        'training',
        'DROP SCHEMA IF EXISTS identity; GRANT CREATE ON DATABASE training TO identity;'
    );
    grantedCreate = true;
    docker(
        [
            'exec',
            '-i',
            target,
            'pg_restore',
            '--exit-on-error',
            '--single-transaction',
            '--no-owner',
            '--no-privileges',
            '--role=identity',
            '-U',
            'training',
            '-d',
            'training',
        ],
        { input: migrated }
    );
    const sourceRealms = Number(sql(legacy, 'identity', 'identity', 'SELECT count(*) FROM public.realm;'));
    const targetRealms = Number(sql(target, 'training', 'training', 'SELECT count(*) FROM identity.realm;'));
    const sourceUsers = Number(sql(legacy, 'identity', 'identity', 'SELECT count(*) FROM public.user_entity;'));
    const targetUsers = Number(sql(target, 'training', 'training', 'SELECT count(*) FROM identity.user_entity;'));
    if (sourceRealms !== targetRealms || sourceUsers !== targetUsers)
        throw new Error('Restored Identity row counts differ; keep legacy source and inspect backups');
    sql(target, 'training', 'training', "COMMENT ON SCHEMA identity IS 'training-desk:shared-identity:v1';");
    console.log(
        `Identity migrated to shared PostgreSQL/training.identity: ${targetRealms} realms, ${targetUsers} users. Backups: ${backupDir}`
    );
    console.log('Legacy DB container/volume retained stopped. Start updated Identity through Docker Compose.');
} catch (error) {
    console.error(`Migration stopped. Original Identity DB and backups were preserved: ${backupDir}`);
    console.error('Identity remains stopped to avoid writes against an ambiguous database; review before restarting.');
    throw error;
} finally {
    if (grantedCreate) sql(target, 'training', 'training', 'REVOKE CREATE ON DATABASE training FROM identity;');
    if (tempCreated) sql(legacy, 'postgres', 'identity', `DROP DATABASE "${tempDb}";`);
}

docker(['stop', legacy], { stdio: 'ignore' });
