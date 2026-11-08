import { mkdtemp, mkdir, copyFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: { tag: { type: 'string' }, prefix: { type: 'string' } },
});
if (!/^sha-[a-f0-9]{40}$/.test(values.tag ?? '')) throw new Error('--tag must be sha- followed by the full commit SHA');
if (!/^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(values.prefix ?? ''))
    throw new Error('--prefix must be a lowercase ghcr.io/owner/image-prefix');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist/deploy');
const temporary = await mkdtemp(join(tmpdir(), 'training-desk-deploy-'));
try {
    for (const file of ['compose.yaml', 'deploy.sh', '.env.example'])
        await copyFile(join(root, 'infra/deploy', file), join(temporary, file));
    await chmod(join(temporary, 'deploy.sh'), 0o755);
    await writeFile(join(temporary, 'images.env'), `IMAGE_PREFIX=${values.prefix}\nIMAGE_TAG=${values.tag}\n`);
    await mkdir(output, { recursive: true });
    const archive = join(output, 'training-desk-deploy.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', temporary, 'compose.yaml', 'deploy.sh', '.env.example', 'images.env'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    console.log(`Deployment bundle: ${archive}`);
} finally {
    await rm(temporary, { recursive: true, force: true });
}
