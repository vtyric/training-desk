/** Seed one default support lead once; later role changes remain controlled by the administrator. */
export async function configureSupportLead(api, password) {
    const realm = await api('');
    if (realm.attributes?.['training.support-lead.version'] === '1') return;
    if (!password || password === 'CHANGE_ME' || password.length < 32)
        throw new Error('SUPPORT_LEAD_PASSWORD must be configured');
    const [resource] = await api('/clients?clientId=service-desk');
    let roles = await api(`/clients/${resource.id}/roles`);
    if (!roles.some((role) => role.name === 'support-lead')) {
        await api(`/clients/${resource.id}/roles`, 'POST', {
            name: 'support-lead',
            description: 'Руководитель поддержки: первоначальный исполнитель новых обращений',
        });
        roles = await api(`/clients/${resource.id}/roles`);
    }
    const leadRole = roles.find((role) => role.name === 'support-lead');
    const staffRole = roles.find((role) => role.name === 'support');
    await api(`/clients/${resource.id}/roles/support-lead/composites`, 'POST', [staffRole]);
    const groupName = 'desk-support-leads';
    let group = (await api(`/groups?search=${groupName}&exact=true`)).find((entry) => entry.name === groupName);
    if (!group) {
        await api('/groups', 'POST', { name: groupName });
        group = (await api(`/groups?search=${groupName}&exact=true`)).find((entry) => entry.name === groupName);
    }
    await api(`/groups/${group.id}/role-mappings/clients/${resource.id}`, 'POST', [leadRole]);
    let [user] = await api('/users?username=support-lead&exact=true');
    if (user && realm.attributes?.['training.support-lead.user-id'] !== user.id)
        throw new Error('support-lead user already exists outside managed provisioning; review before retrying');
    if (!user) {
        await api('/users', 'POST', {
            username: 'support-lead',
            enabled: true,
            firstName: 'Руководитель',
            lastName: 'поддержки',
            attributes: { team_slug: ['demo'] },
            credentials: [{ type: 'password', value: password, temporary: false }],
        });
        [user] = await api('/users?username=support-lead&exact=true');
        const current = await api('');
        await api('', 'PUT', {
            ...current,
            attributes: { ...current.attributes, 'training.support-lead.user-id': user.id },
        });
    }
    await api(`/users/${user.id}/groups/${group.id}`, 'PUT');
    const current = await api('');
    await api('', 'PUT', { ...current, attributes: { ...current.attributes, 'training.support-lead.version': '1' } });
    console.log('Support lead configured for the default Service Desk; existing users and passwords preserved.');
}
