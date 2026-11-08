import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const secret = process.env.TEAM_WEBHOOK_SECRET;
if (!secret) throw new Error('Set TEAM_WEBHOOK_SECRET to the key provided by the stand administrator');
const directory = resolve('.data');
mkdirSync(directory, { recursive: true });
const file = resolve(directory, 'service-desk-events.ndjson');
const seen = new Set(
    existsSync(file)
        ? readFileSync(file, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line).eventId)
        : []
);
const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/webhooks/service-desk') {
        response.writeHead(404).end();
        return;
    }
    try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > 131072) {
                response.writeHead(413).end();
                return;
            }
            chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks);
        const signature = String(request.headers['x-training-signature'] ?? '');
        if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) {
            response.writeHead(401).end();
            return;
        }
        const actual = Buffer.from(signature.slice(7), 'hex');
        const expected = createHmac('sha256', secret).update(raw).digest();
        if (!timingSafeEqual(actual, expected)) {
            response.writeHead(401).end();
            return;
        }
        const eventId = request.headers['x-training-event-id'];
        if (typeof eventId !== 'string' || !/^[a-f0-9-]{36}$/i.test(eventId)) {
            response.writeHead(400).end();
            return;
        }
        if (seen.has(eventId)) {
            response.writeHead(204).end();
            return;
        }
        let payload;
        try {
            payload = JSON.parse(raw.toString('utf8'));
        } catch {
            response.writeHead(400).end();
            return;
        }
        appendFileSync(file, JSON.stringify({ eventId, payload }) + '\n', { mode: 0o600, flush: true });
        seen.add(eventId);
        console.log(JSON.stringify({ eventId, event: payload.webhookEvent, issueKey: payload.issue?.key }));
        response.writeHead(204).end();
    } catch {
        if (!response.headersSent) response.writeHead(500);
        response.end();
    }
});
server.requestTimeout = 15000;
server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => {
    console.log('Webhook receiver started; accepted events are saved in .data/service-desk-events.ndjson');
});
