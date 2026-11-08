/** Migrate the existing LDAP backed login while preserving its Keycloak user ID, roles and credentials. */
export async function renameDemoSupportLogin(api) {
    const oldLogin = await api('/users?username=agent&exact=true');
    const newLogin = await api('/users?username=support&exact=true');
    if (!Array.isArray(oldLogin) || !Array.isArray(newLogin)) throw new Error('Could not inspect support account');
    if (oldLogin.length === 0) {
        if (newLogin.length === 1) return;
        throw new Error('The support account is missing from Identity');
    }
    if (oldLogin.length !== 1 || newLogin.length !== 0)
        throw new Error('Cannot rename the support account: the source is ambiguous or the new login is occupied');
    const user = await api(`/users/${oldLogin[0].id}`);
    const realm = await api('');
    let enabledUsernameEdit = false;
    try {
        if (!realm.editUsernameAllowed) {
            await api('', 'PUT', { ...realm, editUsernameAllowed: true });
            enabledUsernameEdit = true;
        }
        await api(`/users/${user.id}`, 'PUT', {
            ...user,
            username: 'support',
        });
        const migrated = await api('/users?username=support&exact=true');
        if (!Array.isArray(migrated) || migrated.length !== 1 || migrated[0].id !== user.id)
            throw new Error('Identity did not preserve the support account during rename');
        console.log('Support login renamed to support; account ID, credentials and role assignments preserved.');
    } finally {
        if (enabledUsernameEdit) {
            const current = await api('');
            await api('', 'PUT', { ...current, editUsernameAllowed: realm.editUsernameAllowed });
        }
    }
}
