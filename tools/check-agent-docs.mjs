import { readFile, readdir, access } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillRoot = resolve(root, '.agents/skills');
const agentInstructions = await readFile(resolve(root, 'AGENTS.md'), 'utf8');
let count = 0;
const failures = [];
const skillNames = new Set();
for (const entry of await readdir(skillRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(skillRoot, entry.name, 'SKILL.md');
    const text = await readFile(path, 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    const name = /^name:\s*([a-z0-9-]+)\s*$/m.exec(header)?.[1];
    const description = /^description:\s*(.+)$/m.exec(header)?.[1];
    if (name !== entry.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? '') || name.length > 64)
        failures.push(`Invalid skill name: ${entry.name}`);
    if (!description || description.length < 20 || /\[TODO|placeholder/i.test(text))
        failures.push(`Missing description or unfinished scaffold: ${entry.name}`);
    if (skillNames.has(name)) failures.push(`Duplicate skill name: ${name}`);
    skillNames.add(name);
    if (!agentInstructions.includes(`.agents/skills/${entry.name}/SKILL.md`))
        failures.push(`Skill is not routed by AGENTS.md: ${entry.name}`);
    const ui = await readFile(resolve(skillRoot, entry.name, 'agents/openai.yaml'), 'utf8');
    if (!ui.includes(`$${name}`)) failures.push(`UI prompt does not invoke its skill: ${entry.name}`);
    count++;
}

const markdown = [
    resolve(root, 'AGENTS.md'),
    resolve(root, 'README.md'),
    ...(await findMarkdown(resolve(root, 'docs'))),
    ...(await findMarkdown(skillRoot)),
];
for (const path of markdown) {
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const href = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
        const target = resolve(dirname(path), decodeURIComponent(href));
        try {
            await access(target);
        } catch {
            failures.push(`Broken local link: ${relative(root, path)} → ${href}`);
        }
    }
}
if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
} else console.log(`Agent docs checked: ${count} repository skills and ${markdown.length} Markdown files`);

async function findMarkdown(directory) {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'vendor') continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) result.push(...(await findMarkdown(path)));
        else if (entry.name.endsWith('.md')) result.push(path);
    }
    return result;
}
