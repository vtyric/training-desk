import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync('apps/identity/theme/artsofte/login/resources/js/continue-session.js', 'utf8').replace(
    'void continueSession();',
    'continueSession();'
);
const origin = 'http://localhost:8081';
const valid = `${origin}/realms/training/login-actions/restart?tab_id=flow-1&skip_logout=true`;
function browser(target: string, blockedStorage = false) {
    const saved = new Map<string, string>();
    const redirects: string[] = [];
    const context = {
        URL,
        TextEncoder,
        Uint8Array,
        crypto: webcrypto,
        document: { getElementById: () => ({ href: target }) },
        location: {
            origin,
            href: `${origin}/realms/training/login-actions/authenticate`,
            replace: (url: string) => redirects.push(url),
        },
        sessionStorage: {
            getItem: (key: string) => {
                if (blockedStorage) throw new Error('Storage blocked');
                return saved.get(key);
            },
            setItem: (key: string, value: string) => saved.set(key, value),
        },
    };
    return { redirects, saved, run: () => runInNewContext(source, context) as Promise<void> };
}
test('known session recovery continues once and stores no authorization URL or credentials', async () => {
    const page = browser(valid);
    await page.run();
    await page.run();
    assert.deepEqual(page.redirects, [valid]);
    assert.equal(page.saved.size, 1);
    for (const [key, value] of page.saved) {
        assert.match(key, /^identity:continue:[a-f0-9]{64}$/);
        assert.match(value, /^\d+$/);
    }
});
test('session recovery rejects foreign origins, logout requests and missing authentication flow', async () => {
    for (const target of [
        valid.replace(origin, 'https://example.com'),
        valid.replace('skip_logout=true', 'skip_logout=false'),
        valid.replace('tab_id=flow-1&', ''),
        valid.replace('/login-actions/restart', '/protocol/openid-connect/logout'),
    ]) {
        const page = browser(target);
        await page.run();
        assert.deepEqual(page.redirects, []);
    }
});
test('blocked browser storage leaves the server continuation link available without redirect loops', async () => {
    const page = browser(valid, true);
    await page.run();
    assert.deepEqual(page.redirects, []);
    assert.equal(page.saved.size, 0);
});
