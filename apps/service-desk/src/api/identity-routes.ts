import type { FastifyInstance } from 'fastify';
import type { Authenticate } from './routes';

/** Returns only a verified API principal; never echoes token claims or request-supplied identity. */
export async function registerIdentityRoutes(app: FastifyInstance, authenticate: Authenticate) {
    app.get('/api/me', async (request, reply) => {
        const principal = await authenticate(request);
        return reply.header('cache-control', 'no-store').send({
            username: principal.username,
            role: principal.role,
            roleName: {
                customer: 'Заявитель',
                support: 'Сотрудник поддержки',
                admin: 'Администратор службы поддержки',
            }[principal.role],
            teamId: principal.teamId,
        });
    });
}
