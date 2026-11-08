import { buildRuntimeApp } from './runtime';
async function main() {
    const app = await buildRuntimeApp();
    const listen = app.getDecorator<{ host: string; port: number }>('listenSettings');
    await app.listen({ host: listen.host, port: listen.port });
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
            void app.close();
        });
}
main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
