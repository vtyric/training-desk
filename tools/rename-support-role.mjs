/** Rename the role and group in place so existing assignments and composites retain their IDs. */
export async function renameSupportRole(api) {
    const [resource] = await api('/clients?clientId=service-desk');
    if (!resource) throw new Error('Service Desk resource client is missing');
    const roles = await api(`/clients/${resource.id}/roles`);
    const oldRole = roles.find((role) => role.name === 'agent');
    const newRole = roles.find((role) => role.name === 'support');
    const oldGroups = (await api('/groups?search=desk-agents&exact=true')).filter(
        (group) => group.name === 'desk-agents'
    );
    const newGroups = (await api('/groups?search=desk-support&exact=true')).filter(
        (group) => group.name === 'desk-support'
    );
    if (oldRole && newRole && oldRole.id !== newRole.id)
        throw new Error('Both old and new support roles exist. Review assignments before migration.');
    if (
        oldGroups.length > 1 ||
        newGroups.length > 1 ||
        (oldGroups.length && newGroups.length && oldGroups[0].id !== newGroups[0].id)
    )
        throw new Error('Both old and new support groups exist. Review memberships before migration.');
    if (oldRole) {
        await api(`/clients/${resource.id}/roles/agent`, 'PUT', {
            ...oldRole,
            name: 'support',
            description: 'Сотрудник поддержки: обработка обращений, статусы и исполнители',
        });
        const renamed = await api(`/clients/${resource.id}/roles/support`);
        if (renamed.id !== oldRole.id) throw new Error('Support role ID changed during migration');
        console.log('Support role renamed in place; existing grants and composite role memberships preserved.');
    } else if (!newRole) {
        throw new Error('Support role is missing from Service Desk client');
    }
    if (oldGroups.length) {
        const group = await api(`/groups/${oldGroups[0].id}`);
        await api(`/groups/${group.id}`, 'PUT', { ...group, name: 'desk-support' });
        console.log('Support group renamed in place; user memberships preserved.');
    }
}
