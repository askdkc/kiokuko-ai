import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const roots = ['src', 'tests', 'scripts', 'docs'];
const files = ['package.json'];
const extensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.md']);
const forbidden = [
  ['client', 'neutral'].join('-'),
  ['model', 'agnostic'].join('-'),
  ['generic', 'Agent'].join(' '),
  ['', 'api', 'v1', 'agent'].join('/'),
  ['kiokuko-ai', 'agent'].join(' '),
  ['kiokuko-ai', 'serve'].join(' '),
  ['kiokuko-ai', 'call'].join(' '),
];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(candidate);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(candidate);
  }
}

for (const root of roots) await collect(root);
for (const entry of await readdir('.', { withFileTypes: true })) {
  if (entry.isFile() && /^README.*\.md$/u.test(entry.name)) files.push(entry.name);
}

const findings = [];
for (const file of files.sort()) {
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const phrase of forbidden) {
      if (line.includes(phrase)) findings.push(`${file}:${index + 1}:${phrase}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('OpenCode-only public boundary verified.\n');
}
