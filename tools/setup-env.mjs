import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({ options: { extend: { type: 'boolean', default: false } } });
const template = await readFile('.env.example', 'utf8');
let original = '';
let hasEnv = false;
try {
    original = await readFile('.env', 'utf8');
    hasEnv = true;
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
if (hasEnv && !values.extend)
    throw new Error('.env exists. Use --extend to add missing keys without changing existing values.');
const existing = parseEnv(original);
let renamedSupportKey = false;
if ('LDAP_AGENT_PASSWORD' in existing) {
    if ('LDAP_SUPPORT_PASSWORD' in existing && existing.LDAP_SUPPORT_PASSWORD !== existing.LDAP_AGENT_PASSWORD)
        throw new Error(
            'LDAP password variables differ. Preserve the active password as LDAP_SUPPORT_PASSWORD before continuing.'
        );
    if (!('LDAP_SUPPORT_PASSWORD' in existing)) {
        original = original.replace(/^LDAP_AGENT_PASSWORD=/m, 'LDAP_SUPPORT_PASSWORD=');
        existing.LDAP_SUPPORT_PASSWORD = existing.LDAP_AGENT_PASSWORD;
    } else {
        original = original
            .split('\n')
            .filter((line) => !line.startsWith('LDAP_AGENT_PASSWORD='))
            .join('\n');
    }
    delete existing.LDAP_AGENT_PASSWORD;
    renamedSupportKey = true;
}
const entries = parseEnv(template);
const postgresPassword = existing.POSTGRES_PASSWORD ?? randomBytes(24).toString('hex');
const added = [];
for (const [key, raw] of Object.entries(entries)) {
    if (key in existing) continue;
    let value = raw;
    if (key === 'POSTGRES_PASSWORD') value = postgresPassword;
    else if (key === 'DATABASE_URL') value = raw.replace('CHANGE_ME', encodeURIComponent(postgresPassword));
    else value = raw.replaceAll('CHANGE_ME', () => randomBytes(24).toString('hex'));
    added.push(`${key}=${value}`);
}
if (added.length || renamedSupportKey)
    await writeFile('.env', (original ? original.trimEnd() + '\n' : '') + added.join('\n') + '\n', {
        flag: hasEnv ? 'w' : 'wx',
        mode: 0o600,
    });
console.log(
    `Local configuration ready: ${added.length} missing keys added; existing values preserved.${renamedSupportKey ? ' Support password variable renamed.' : ''}`
);
