import { createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { 'team-id': { type: 'string' } } });
const id = values['team-id'];
if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
    throw new Error('Use --team-id UUID for the intended team');
if (!process.env.WEBHOOK_SIGNING_SECRET) throw new Error('WEBHOOK_SIGNING_SECRET is required');
console.log(createHmac('sha256', process.env.WEBHOOK_SIGNING_SECRET).update(id).digest('hex'));
