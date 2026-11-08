import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const source = 'https://developer.atlassian.com/server/jira-servicedesk/10.3.swagger.v3.json';
const response = await fetch(source);
if (!response.ok) throw new Error(`Atlassian OpenAPI download failed: ${response.status}`);
const content = await response.text();
const spec = JSON.parse(content);
if (!spec.info.version.startsWith('10.3.')) throw new Error('Unexpected Jira API version');
await mkdir('docs/vendor', { recursive: true });
await writeFile('docs/vendor/jira-10.3.openapi.json', content);
await writeFile(
    'docs/vendor/source.json',
    JSON.stringify(
        {
            source,
            version: spec.info.version,
            fetchedAt: new Date().toISOString(),
            sha256: createHash('sha256').update(content).digest('hex'),
        },
        null,
        4
    ) + '\n'
);
console.log(`Saved official Jira ${spec.info.version} specification`);
