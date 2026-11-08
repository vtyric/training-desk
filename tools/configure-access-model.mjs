/** One-time upgrade of demo role assignments; later access changes belong to the administrator. */
export async function configureAccessModel(api, adminPassword) {
    const realm = await api('');
    if (realm.attributes?.['training.access-model.version'] === '1') {
        console.log('Access model is already configured; administrator-managed memberships and roles preserved.');
        return;
    }
    if (!adminPassword || adminPassword === 'CHANGE_ME') throw new Error('DESK_ADMIN_PASSWORD must be configured');
    const [resource] = await api('/clients?clientId=service-desk');
    if (!resource) throw new Error('Service Desk resource client is missing');
    const definitions = [
        ['desk-customers', 'customer', 'Заявитель: создание и чтение своих заявок, публичные комментарии'],
        [
            'desk-support',
            'support',
            'Сотрудник поддержки: обработка обращений, статусы, исполнители и внутренние заметки',
        ],
        ['desk-admins', 'admin', 'Администратор Service Desk: все настройки сервиса и обработка обращений'],
    ];
    const groups = new Map();
    const roles = new Map();
    for (const [name, role, description] of definitions) {
        const representation = await api(`/clients/${resource.id}/roles/${role}`);
        roles.set(role, representation);
        await api(`/clients/${resource.id}/roles/${role}`, 'PUT', { ...representation, description });
        let group = (await api(`/groups?search=${encodeURIComponent(name)}&exact=true`)).find((g) => g.name === name);
        if (!group) {
            await api('/groups', 'POST', { name });
            group = (await api(`/groups?search=${encodeURIComponent(name)}&exact=true`)).find((g) => g.name === name);
        }
        if (!group) throw new Error(`Group ${name} could not be created`);
        await api(`/groups/${group.id}/role-mappings/clients/${resource.id}`, 'POST', [representation]);
        groups.set(name, group.id);
    }
    for (const [username, group, oldRoles] of [
        ['alice', 'desk-customers', ['customer']],
        ['support', 'desk-support', ['customer', 'support']],
    ]) {
        const [user] = await api(`/users?username=${username}&exact=true`);
        if (!user) throw new Error(`Demo user ${username} is missing`);
        await api(`/users/${user.id}/groups/${groups.get(group)}`, 'PUT');
        // Move only the known initial demo grants into groups, retaining any other operator grants.
        await api(
            `/users/${user.id}/role-mappings/clients/${resource.id}`,
            'DELETE',
            oldRoles.map((r) => roles.get(r))
        );
    }
    let [deskAdmin] = await api('/users?username=desk-admin&exact=true');
    const ownedId = realm.attributes?.['training.access-model.admin-id'];
    if (deskAdmin && deskAdmin.id !== ownedId)
        throw new Error('desk-admin already exists outside managed provisioning; rename the fixture before retrying');
    if (!deskAdmin) {
        await api('/users', 'POST', {
            username: 'desk-admin',
            enabled: true,
            firstName: 'Администратор',
            lastName: 'службы поддержки',
            attributes: { team_slug: ['demo'] },
            credentials: [{ type: 'password', value: adminPassword, temporary: false }],
        });
        [deskAdmin] = await api('/users?username=desk-admin&exact=true');
        if (!deskAdmin) throw new Error('desk-admin creation failed');
        const current = await api('');
        await api('', 'PUT', {
            ...current,
            attributes: { ...current.attributes, 'training.access-model.admin-id': deskAdmin.id },
        });
    }
    await api(`/users/${deskAdmin.id}/groups/${groups.get('desk-admins')}`, 'PUT');
    const current = await api('');
    await api('', 'PUT', {
        ...current,
        attributes: { ...current.attributes, 'training.access-model.version': '1' },
    });
    console.log('Access model configured: desk-customers, desk-support, desk-admins; separate desk-admin account.');
}
