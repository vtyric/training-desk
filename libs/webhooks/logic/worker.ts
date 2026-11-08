import { DeliveryStore } from '../dal/store';
import { sendWebhook } from '../dal/transport';

const RETRIES = [10_000, 60_000, 300_000, 900_000];

/** Handles a single leased delivery. Retry semantics are training-specific. */
export async function deliverNext(store: DeliveryStore, send = sendWebhook, retryDelaysMs = RETRIES): Promise<boolean> {
    const delivery = await store.claim();
    if (!delivery) return false;
    let status: number | null = null;
    let error: string | null = null;
    try {
        status = await send(delivery.url, delivery.secret, delivery.event_id, JSON.stringify(delivery.payload));
    } catch {
        error = 'Destination unavailable, timeout, or unsafe address';
    }
    const success = status !== null && status >= 200 && status < 300;
    const retryable = status === null || status === 429 || status >= 500;
    const delay = retryDelaysMs[delivery.attempt - 1];
    await store.finish(
        delivery.id,
        success ? 'delivered' : retryable && delay !== undefined ? 'pending' : 'failed',
        status,
        error,
        delay ?? 0
    );
    return true;
}

/** Polls the outbox without overlapping runs; shutdown waits for the in-flight delivery. */
export function startWorker(
    store: DeliveryStore,
    onError: (error: unknown) => void,
    options: {
        pollIntervalMs?: number;
        batchSize?: number;
        timeoutMs?: number;
        retryDelaysMs?: number[];
        projectSettings?: () => Promise<void>;
    } = {}
) {
    let stopped = false;
    let running: Promise<void> | undefined;
    const tick = () => {
        if (stopped || running) return;
        running = (async () => {
            await options.projectSettings?.();
            await store.prepare();
            for (let n = 0; n < (options.batchSize ?? 20) && !stopped; n++)
                if (
                    !(await deliverNext(
                        store,
                        (url, secret, id, payload) => sendWebhook(url, secret, id, payload, options.timeoutMs ?? 10000),
                        options.retryDelaysMs ?? RETRIES
                    ))
                )
                    break;
        })()
            .catch(onError)
            .finally(() => {
                running = undefined;
            });
    };
    const interval = setInterval(tick, options.pollIntervalMs ?? 1000);
    interval.unref();
    tick();
    return async () => {
        stopped = true;
        clearInterval(interval);
        await running;
        await store.close();
    };
}
