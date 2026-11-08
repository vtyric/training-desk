/** Managed machine client: read employee eligibility, never change users or their roles. */
export async function configureDirectoryClient(api, secret) {
    if (!secret || secret === 'CHANGE_ME' || secret.length < 32)
        throw new Error('IDENTITY_DIRECTORY_CLIENT_SECRET must contain at least 32 characters');
    const clientId = 'service-desk-directory';
    const existing = (await api(`/clients?clientId=${clientId}`)).find((entry) => entry.clientId === clientId);
    if (existing && existing.attributes?.['training.managed-directory'] !== 'true')
        throw new Error('Directory client already exists outside managed provisioning; review it before retrying');
    const client = {
        ...(existing || {}),
        clientId,
        name: 'Service Desk employee directory',
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        bearerOnly: false,
        clientAuthenticatorType: 'client-secret',
        secret,
        standardFlowEnabled: false,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: true,
        fullScopeAllowed: true,
        defaultClientScopes: ['roles'],
        optionalClientScopes: [],
        redirectUris: [],
        webOrigins: [],
        attributes: { ...(existing?.attributes || {}), 'training.managed-directory': 'true' },
    };
    if (existing) await api(`/clients/${existing.id}`, 'PUT', client);
    else await api('/clients', 'POST', client);
    const [created] = await api(`/clients?clientId=${clientId}`);
    const account = await api(`/clients/${created.id}/service-account-user`);
    const [management] = await api('/clients?clientId=realm-management');
    if (!management) throw new Error('Realm management client is missing');
    const roleNames = ['view-users', 'query-users', 'view-clients'];
    const roles = await Promise.all(roleNames.map((name) => api(`/clients/${management.id}/roles/${name}`)));
    const assigned = await api(`/users/${account.id}/role-mappings/clients/${management.id}`);
    const extra = assigned.filter((role) => !roleNames.includes(role.name));
    if (extra.length) await api(`/users/${account.id}/role-mappings/clients/${management.id}`, 'DELETE', extra);
    await api(`/users/${account.id}/role-mappings/clients/${management.id}`, 'POST', roles);
    console.log('Employee directory client configured with read-only Identity permissions.');
}
