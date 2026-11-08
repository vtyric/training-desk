import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { createAccessTokenAuth } from '../libs/auth';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'primary', alg: 'RS256', use: 'sig' };
const issuer = 'http://localhost:1/realms/training';
let server: Server;
let internalIssuer: string;
let auth: ReturnType<typeof createAccessTokenAuth>;
let poisonedDiscovery = false;
let discoveryRequests = 0;
let keyRequests = 0;

function token(claims: Record<string, unknown> = {}, badSignature = false, algorithm = 'RS256') {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: 'primary' })).toString('base64url');
    const payload = Buffer.from(
        JSON.stringify({
            iss: issuer,
            aud: 'service-desk',
            sub: 'test-subject',
            iat: now,
            exp: now + 300,
            typ: 'Bearer',
            preferred_username: 'alice',
            team_slug: 'demo',
            resource_access: { 'service-desk': { roles: ['customer'] } },
            ...claims,
        })
    ).toString('base64url');
    const signed = `${header}.${payload}`;
    return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), badSignature ? other.privateKey : key.privateKey).toString('base64url')}`;
}

before(async () => {
    server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/realms/training/.well-known/openid-configuration') {
            discoveryRequests++;
            response.end(
                JSON.stringify({
                    issuer,
                    jwks_uri: poisonedDiscovery
                        ? 'http://evil.example/keys'
                        : `${issuer}/protocol/openid-connect/certs`,
                })
            );
            return;
        }
        if (request.url === '/realms/training/protocol/openid-connect/certs') {
            keyRequests++;
            response.end(JSON.stringify({ keys: [jwk] }));
            return;
        }
        response.statusCode = 404;
        response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    internalIssuer = `http://127.0.0.1:${address.port}/realms/training`;
    auth = createAccessTokenAuth(
        { issuerUrl: issuer, internalIssuerUrl: internalIssuer, audience: 'service-desk', allowInsecureLocal: true },
        async (slug) => (slug === 'demo' ? 'team-one' : null)
    );
});

after(async () => {
    await auth?.close();
    if (server)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test('real RSA JWKS verification rewrites only server transport and preserves public issuer', async () => {
    const signed = token();
    const principal = await auth.authenticateToken(signed);
    assert.equal(principal?.expiresAt, JSON.parse(Buffer.from(signed.split('.')[1], 'base64url').toString()).exp);
    const { expiresAt: _expiresAt, ...identity } = principal!;
    assert.deepEqual(identity, {
        username: 'alice',
        teamId: 'team-one',
        role: 'customer',
    });
    assert.equal(discoveryRequests, 1);
    assert.equal(keyRequests, 1);
    assert.equal(
        (await auth.authenticateToken(token({ resource_access: { 'service-desk': { roles: ['support'] } } })))?.role,
        'support'
    );
    assert.equal(keyRequests, 1, 'JWKS is cached');
});

test('audience, issuer, expiry, token type, missing required claims, algorithm and signature are enforced', async () => {
    for (const invalid of [
        token({ aud: 'student-app' }),
        token({ iss: 'https://wrong-issuer.example' }),
        token({ exp: Math.floor(Date.now() / 1000) - 60 }),
        token({ exp: undefined }),
        token({ sub: undefined }),
        token({ iat: undefined }),
        token({ typ: 'ID' }),
        token({}, true),
        token({}, false, 'HS256'),
        'not-a-token',
    ])
        assert.equal(await auth.authenticateToken(invalid), null);
});

test('signed JWT without the correct client role or local active team is denied', async () => {
    for (const claims of [
        { resource_access: { 'student-app': { roles: ['admin'] } } },
        { resource_access: { 'service-desk': { roles: [] } } },
        { team_slug: 'missing-team' },
        { team_slug: undefined },
    ])
        await assert.rejects(auth.authenticateToken(token(claims)), { statusCode: 403 });
});

test('untrusted discovery endpoints fail before any connection to that host', async () => {
    poisonedDiscovery = true;
    try {
        const another = createAccessTokenAuth(
            {
                issuerUrl: issuer,
                internalIssuerUrl: internalIssuer,
                audience: 'service-desk',
                allowInsecureLocal: true,
            },
            async () => 'team-one'
        );
        await assert.rejects(another.authenticateToken(token()), { statusCode: 503 });
    } finally {
        poisonedDiscovery = false;
    }
});
