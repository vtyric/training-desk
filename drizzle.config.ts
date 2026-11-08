import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    dialect: 'postgresql',
    schema: './apps/service-desk/src/dal/schema.ts',
    out: './apps/service-desk/src/dal/migrations',
    dbCredentials: { url: process.env['DATABASE_URL'] ?? '' },
});
