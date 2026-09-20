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
    // Excluding a private agent directory from snapshots is not client support.
    // Allow only this quoted entry in the exclusion declaration; keep scanning
    // the rest of the file and any comment following the declaration.
    const checkedLine = file === 'src/source-context/snapshot.ts'
      ? line.replace(/^const EXCLUDED = new Set\(\[[^\]]*\]\);/u,
        (declaration) => declaration.replaceAll(`'.${foreignAgents[0]}'`, ''))
      : line;
    const lowercase = checkedLine.toLowerCase();
    for (const agent of foreignAgents) {
      if (lowercase.includes(agent)) findings.push(`${file}:${index + 1}:${agent}`);
    }
  }
}

const migrationEntries = await readdir('migrations');
const migrationSqlFiles = migrationEntries.filter((entry) => entry.endsWith('.sql')).sort();
// Current migrations grow with the package; historical fixtures pin their own version.
for (const [index, name] of migrationSqlFiles.entries()) {
  const match = /^(\d{3})_[a-z0-9_-]+\.sql$/u.exec(name);
  if (!match || Number(match[1]) !== index + 1) findings.push(`migrations: invalid sequence at ${name}`);
}
if (migrationSqlFiles.length === 0) findings.push('migrations: no migrations found');

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
