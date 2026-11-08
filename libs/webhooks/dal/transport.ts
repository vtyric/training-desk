import { request } from 'node:https';
import { createHmac } from 'node:crypto';
import { resolveDestination } from './destination';

/** Sends one bounded request with DNS pinning and no redirect following. */
export async function sendWebhook(
    url: string,
    secret: string,
    eventId: string,
    payload: string,
    timeoutMs = 10000
): Promise<number> {
    const target = await resolveDestination(url);
    return new Promise((resolve, reject) => {
        const outgoing = request(
            target.url,
            {
                method: 'POST',
                timeout: timeoutMs,
                lookup: (_hostname, options, callback) => {
                    if (options && typeof options === 'object' && 'all' in options && options.all) {
                        callback(null, [{ address: target.address, family: target.family }]);
                        return;
                    }
                    callback(null, target.address, target.family);
                },
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                    'x-training-event-id': eventId,
                    'x-training-signature': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
                },
            },
            (response) => {
                // Consume only a bounded response; receipt of headers is enough to classify delivery.
                response.destroy();
                resolve(response.statusCode ?? 0);
            }
        );
        outgoing.on('timeout', () => outgoing.destroy(new Error('Webhook timeout')));
        outgoing.on('error', reject);
        outgoing.end(payload);
    });
}
