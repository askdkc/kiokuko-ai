import { readFile, readdir, stat } from 'node:fs/promises';
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
const foreignAgents = [
  ['co', 'dex'].join(''),
  ['cla', 'ude'].join(''),
  ['her', 'mes'].join(''),
  ['ai', 'der'].join(''),
  ['gem', 'ini'].join(''),
  ['wind', 'surf'].join(''),
  ['cop', 'ilot'].join(''),
];
const foreignAgentAllowlist = new Set([
  'tests/unit/enno-core.test.ts',
  'tests/unit/ledger-validation.test.ts',
  'tests/integration/schema-integrity.test.ts',
]);
const removedGatewayDirectories = ['src/client', 'src/gateway', 'src/server/routes'];
const removedGatewayCommands = ['agent', 'serve', 'call', 'server'];

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
    if (foreignAgentAllowlist.has(file)) continue;
    const lowercase = line.toLowerCase();
    for (const agent of foreignAgents) {
      if (lowercase.includes(agent)) findings.push(`${file}:${index + 1}:${agent}`);
    }
  }
}

const migrationEntries = await readdir('migrations');
const migrationSqlFiles = migrationEntries.filter((entry) => entry.endsWith('.sql'));
if (migrationSqlFiles.length !== 1 || migrationSqlFiles[0] !== '001_initial.sql') {
  findings.push(`migrations: expected only 001_initial.sql, found [${migrationSqlFiles.join(', ')}]`);
}

for (const directory of removedGatewayDirectories) {
  let exists = false;
  try {
    exists = (await stat(directory)).isDirectory();
  } catch {
    exists = false;
  }
  if (exists) findings.push(`${directory}: removed gateway directory must not exist`);
}

const cliSource = await readFile('src/cli.ts', 'utf8');
for (const command of removedGatewayCommands) {
  const pattern = new RegExp(`\\.command\\(\\s*['"]${command}['"]\\s*[,)]`, 'u');
  if (pattern.test(cliSource)) findings.push(`src/cli.ts: removed command '${command}' must not be registered`);
}

if (findings.length > 0) {
  process.stderr.write(`${findings.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('OpenCode-only public boundary verified.\n');
}
