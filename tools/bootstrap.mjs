import { execFileSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = parseArgs({
    options: {
        mode: { type: 'string', default: 'docker' },
        apply: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
    },
});
const { mode, apply, help } = options.values;

if (help) {
    console.log('Usage: node tools/bootstrap.mjs --mode docker|dev [--apply]');
    console.log('Without --apply: print a plan only. Existing .env and volumes are never replaced.');
} else {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Setup failed');
        process.exitCode = 1;
    }
}

async function main() {
    if (!['docker', 'dev'].includes(mode)) throw new Error('Mode must be docker or dev');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    if (pkg.name !== '@training-desk/source') throw new Error('Unexpected repository; setup stopped');
    const envExists = await exists(new URL('../.env', import.meta.url));
    const commands =
        mode === 'docker'
            ? [
                  ['docker', 'compose', '-f', 'compose.yaml', 'config', '--quiet'],
                  ['docker', 'compose', '-f', 'compose.yaml', 'up', '-d', '--wait', 'postgres'],
                  [process.execPath, '--env-file=.env', 'tools/migrate-identity-database.mjs', '--apply'],
                  ['docker', 'compose', '-f', 'compose.yaml', 'up', '--build', '-d', '--wait'],
                  [process.execPath, '--env-file=.env', 'tools/configure-identity.mjs'],
              ]
            : [
                  ['pnpm', 'install', '--frozen-lockfile'],
                  [
                      'docker',
                      'compose',
                      '-f',
                      'compose.yaml',
                      '-f',
                      'infra/compose/dev.yaml',
                      'up',
                      '-d',
                      '--wait',
                      'postgres',
                  ],
                  [process.execPath, '--env-file=.env', 'tools/migrate-identity-database.mjs', '--apply'],
                  ['pnpm', 'infra:start'],
                  ['pnpm', 'db:migrate'],
                  ['pnpm', 'db:seed'],
                  [process.execPath, '--env-file=.env', 'tools/configure-identity.mjs'],
              ];
    console.log(`Setup mode: ${mode}; ${apply ? 'apply' : 'plan only'}`);
    console.log(envExists ? 'Keep existing .env' : 'Create .env with independent random local secrets');
    if (!envExists) console.log('  node tools/setup-env.mjs');
    for (const command of commands) console.log(`  ${command.join(' ')}`);
    if (!apply) return;

    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || major >= 25 || (major === 22 && minor < 12))
        throw new Error(
            'Use Node >=22.12 and <25; the recommended version is in .nvmrc. No system settings were changed.'
        );
    capture('docker', ['version', '--format', '{{.Server.Version}}']);
    const composeVersion = capture('docker', ['compose', 'version', '--short']);
    if (Number(composeVersion.match(/\d+/)?.[0] ?? 0) < 2) throw new Error('Docker Compose v2 or newer is required');
    const contextHost =
        process.env.DOCKER_HOST ||
        JSON.parse(capture('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']));
    if (!/^(unix:|npipe:)/.test(contextHost))
        throw new Error(
            'Setup expects a local Docker endpoint; the selected endpoint must be reviewed separately. Context was not changed.'
        );
    if (mode === 'dev') {
        const expected = pkg.packageManager.split('@').at(-1);
        if (capture('pnpm', ['--version']) !== expected)
            throw new Error(
                `Use pnpm ${expected} from packageManager. Setup does not install or replace global tools.`
            );
    }
    // Validate existing files before writing anything or installing dependencies.
    if (envExists) await validateEnv();
    else {
        run(process.execPath, ['tools/setup-env.mjs']);
        await validateEnv();
    }
    for (const [command, ...args] of commands) run(command, args);
    console.log(
        mode === 'docker'
            ? 'Docker setup completed. See docker compose ps --all; the default portal is http://localhost:8080.'
            : 'Development infrastructure is ready. Run pnpm start when you need the local servers.'
    );
}

async function exists(url) {
    try {
        await access(url);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function validateEnv() {
    const { parseEnv } = await import('node:util');
    const values = { ...parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')), ...process.env };
    const required = [
        'POSTGRES_PASSWORD',
        'ADMIN_TOKEN',
        'TEAM_API_TOKEN',
        'CUSTOMER_API_TOKEN',
        'IDENTITY_DB_PASSWORD',
        'IDENTITY_ADMIN_PASSWORD',
        'IDENTITY_DIRECTORY_CLIENT_SECRET',
        'DESK_ADMIN_PASSWORD',
        'SUPPORT_LEAD_PASSWORD',
        'WEBHOOK_SIGNING_SECRET',
        'LDAP_ADMIN_PASSWORD',
        'LDAP_ALICE_PASSWORD',
        'LDAP_SUPPORT_PASSWORD',
        'LDAP_DENIED_PASSWORD',
    ];
    if (mode === 'dev') required.push('DATABASE_URL', 'BASE_URL', 'OIDC_ISSUER_URL', 'IDENTITY_PUBLIC_URL');
    const missing = required.filter((key) => !values[key] || values[key].includes('CHANGE_ME'));
    if (missing.length)
        throw new Error(`Configure these .env keys without resetting existing data: ${missing.join(', ')}`);
}

function capture(command, args) {
    try {
        return execFileSync(command, args, {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 15000,
        }).trim();
    } catch {
        throw new Error(`Prerequisite failed: ${command} ${args.join(' ')}. No tools or contexts were changed.`);
    }
}

function run(command, args) {
    try {
        execFileSync(command, args, { cwd: root, stdio: 'inherit' });
    } catch {
        throw new Error(`Setup stopped at: ${command} ${args.join(' ')}. Existing .env and volumes were preserved.`);
    }
}
