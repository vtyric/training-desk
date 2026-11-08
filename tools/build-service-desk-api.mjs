import { build } from 'esbuild';

await build({
    entryPoints: {
        main: 'apps/service-desk/src/main.ts',
        migrate: 'apps/service-desk/src/dal/migrate.ts',
        seed: 'apps/service-desk/src/dal/seed.ts',
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    packages: 'external',
    outdir: 'dist/apps/service-desk/api',
    outExtension: { '.js': '.cjs' },
    logLevel: 'info',
});
