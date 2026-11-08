import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'apps/identity/theme');
const target = resolve(root, 'dist/apps/identity/theme');
const loginResources = resolve(target, 'artsofte/login/resources');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(resolve(source, 'artsofte'), resolve(target, 'artsofte'), { recursive: true });
await mkdir(resolve(loginResources, 'css'), { recursive: true });
await mkdir(resolve(loginResources, 'fonts'), { recursive: true });
const css = compile(resolve(source, 'styles.scss'), {
    loadPaths: [resolve(root, 'libs/theme/src')],
    style: 'compressed',
}).css.replaceAll('/brand/montserrat-', '../fonts/montserrat-');
await writeFile(resolve(loginResources, 'css/theme.css'), css);
const propertiesPath = resolve(target, 'artsofte/login/theme.properties');
const properties = await readFile(propertiesPath, 'utf8');
const continueScript = await readFile(resolve(source, 'artsofte/login/resources/js/continue-session.js'), 'utf8');
await writeFile(
    propertiesPath,
    `${properties.trimEnd()}\nstylesVersion=${createHash('sha256').update(css).update(continueScript).digest('hex').slice(0, 12)}\n`
);
for (const filename of ['montserrat-cyrillic.woff2', 'montserrat-latin.woff2', 'OFL.txt']) {
    await cp(resolve(root, 'libs/theme/assets/brand', filename), resolve(loginResources, 'fonts', filename));
}
const sources = JSON.parse(await readFile(resolve(root, 'libs/theme/assets/brand/sources.json'), 'utf8'));
await writeFile(resolve(loginResources, 'fonts/sources.json'), JSON.stringify(sources, null, 2) + '\n');
console.log('Identity theme built: dist/apps/identity/theme/artsofte');
