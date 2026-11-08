import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issuerUrl } from './dal/access-token-verifier';
import { AccessTokenAuthService } from './logic/auth-service';
import type { AccessTokenVerifier, VerifiedAccessClaims } from './types';

const identity: VerifiedAccessClaims = {
    sub: 'test-id',
    preferred_username: 'alice',
    team_slug: 'demo',
    resource_access: { 'service-desk': { roles: ['customer'] } },
};
function service(claims: VerifiedAccessClaims | null, active = true) {
    const verifier: AccessTokenVerifier = {
        async verify() {
            return claims;
        },
    };
    return new AccessTokenAuthService(verifier, 'service-desk', async (slug) =>
        active && slug === 'demo' ? 'team-id' : null
    );
}

test('resource-server maps verified client roles and tenant; LDAP/realm roles cannot grant access', async () => {
    assert.deepEqual(await service(identity).authenticateToken('jwt'), {
        teamId: 'team-id',
        username: 'alice',
        role: 'customer',
    });
    for (const role of ['support', 'admin'] as const)
        assert.equal(
            (
                await service({
                    ...identity,
                    resource_access: { 'service-desk': { roles: [role] } },
                }).authenticateToken('jwt')
            )?.role,
            role
        );
    for (const claims of [
        // The removed role must not continue granting support permissions after migration.
        { ...identity, resource_access: { 'service-desk': { roles: ['agent'] } } },
        { ...identity, resource_access: { 'other-client': { roles: ['admin'] } } },
        { ...identity, resource_access: { 'service-desk': { roles: [] } } },
        { ...identity, resource_access: { 'service-desk': { roles: 'admin' } } },
        { ...identity, resource_access: undefined },
    ])
        await assert.rejects(service(claims).authenticateToken('jwt'), { statusCode: 403 });
    assert.equal(
        (
            await service({
                ...identity,
                resource_access: { 'service-desk': { roles: ['customer'] }, 'other-client': { roles: ['admin'] } },
            }).authenticateToken('jwt')
        )?.role,
        'customer'
    );
});

test('invalid tokens, missing profile and inactive/unknown tenant fail closed', async () => {
    assert.equal(await service(null).authenticateToken('jwt'), null);
    for (const claims of [
        { ...identity, team_slug: undefined },
        { ...identity, preferred_username: '' },
        { ...identity, team_slug: 'unknown' },
    ])
        await assert.rejects(service(claims).authenticateToken('jwt'), { statusCode: 403 });
    await assert.rejects(service(identity, false).authenticateToken('jwt'), { statusCode: 403 });
});

test('identity HTTP is explicit and restricted to local development endpoints', () => {
    assert.throws(() => issuerUrl('http://identity.example/realms/training', true), /requires HTTPS/);
    assert.throws(() => issuerUrl('http://localhost:8081/realms/training', false), /requires HTTPS/);
    assert.equal(issuerUrl('http://localhost:8081/realms/training', true).origin, 'http://localhost:8081');
    assert.equal(issuerUrl('http://identity:8080/realms/training', true, true).hostname, 'identity');
    assert.throws(() => issuerUrl('https://name:secret@identity.example/realms/training', false), /requires HTTPS/);
});
