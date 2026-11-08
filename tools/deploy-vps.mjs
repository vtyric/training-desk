import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const required = [
    'VPS_HOST',
    'VPS_PORT',
    'VPS_USER',
    'VPS_SSH_KEY',
    'VPS_KNOWN_HOSTS',
    'GHCR_TOKEN',
    'GHCR_USER',
    'GITHUB_SHA',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing deployment configuration: ${missing.join(', ')}`);
const env = process.env;
if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(env.VPS_HOST)) throw new Error('Invalid VPS_HOST');
if (!/^[a-z_][a-z0-9_-]*$/.test(env.VPS_USER)) throw new Error('Invalid VPS_USER');
if (!/^\d+$/.test(env.VPS_PORT) || Number(env.VPS_PORT) < 1 || Number(env.VPS_PORT) > 65535)
    throw new Error('Invalid VPS_PORT');
if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)) throw new Error('Invalid GITHUB_SHA');
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(env.GHCR_USER)) throw new Error('Invalid GHCR_USER');
if (!/^\d+$/.test(env.GITHUB_RUN_ID) || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT))
    throw new Error('Invalid workflow run identifier');
const archive = resolve('dist/deploy/training-desk-deploy.tar.gz');
await access(archive);
const temporary = await mkdtemp(join(tmpdir(), 'training-desk-ssh-'));
try {
    const key = join(temporary, 'key');
    const hosts = join(temporary, 'known_hosts');
    await writeFile(key, `${env.VPS_SSH_KEY.trim()}\n`, { mode: 0o600 });
    await writeFile(hosts, `${env.VPS_KNOWN_HOSTS.trim()}\n`, { mode: 0o600 });
    const options = [
        '-i',
        key,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        `UserKnownHostsFile=${hosts}`,
        '-o',
        'ConnectTimeout=15',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
    ];
    const host = `${env.VPS_USER}@${env.VPS_HOST}`;
    const ssh = [...options, '-p', env.VPS_PORT, host];
    const incoming = `/opt/training-desk/incoming/${env.GITHUB_SHA}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}.tar.gz`;
    execFileSync('ssh', [...ssh, 'umask 077; mkdir -p /opt/training-desk/incoming'], { stdio: 'inherit' });
    execFileSync('scp', [...options, '-P', env.VPS_PORT, archive, `${host}:${incoming}`], { stdio: 'inherit' });
    const script = `set -eu
umask 077
base=/opt/training-desk
exec 9>"$base/deploy.lock"
flock -w 600 9
[ -f "$base/.env" ] || { echo 'Missing /opt/training-desk/.env' >&2; exit 1; }
registry_config=$(mktemp -d)
cleanup() { rm -rf -- "$registry_config"; rm -f -- '${incoming}'; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export DOCKER_CONFIG="$registry_config"
docker login ghcr.io --username '${env.GHCR_USER}' --password-stdin
previous_sha=$(basename "$(readlink "$base/current" 2>/dev/null || true)")
if [ "$previous_sha" = '${env.GITHUB_SHA}' ]; then
    previous_sha=$(basename "$(readlink "$base/previous" 2>/dev/null || true)")
fi
if ! printf '%s\\n' "$previous_sha" | grep -Eq '^[a-f0-9]{40}$'; then previous_sha=; fi
release="$base/releases/${env.GITHUB_SHA}"
mkdir -p "$release"
tar -xzf '${incoming}' --no-same-owner -C "$release"
ln -sfn ../../.env "$release/.env"
cd "$release"
./deploy.sh
if [ -n "$previous_sha" ]; then ln -sfn "releases/$previous_sha" "$base/previous"; fi
ln -sfn 'releases/${env.GITHUB_SHA}' "$base/current"
previous_tag=
if [ -n "$previous_sha" ]; then previous_tag="sha-$previous_sha"; fi
./cleanup-images.sh ghcr.io/vtyric/training-desk 'sha-${env.GITHUB_SHA}' "$previous_tag"
`;
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    execFileSync('ssh', [...ssh, `sh -c ${quote(script)}`], {
        input: `${env.GHCR_TOKEN}\n`,
        stdio: ['pipe', 'inherit', 'inherit'],
    });
} finally {
    await rm(temporary, { recursive: true, force: true });
}
