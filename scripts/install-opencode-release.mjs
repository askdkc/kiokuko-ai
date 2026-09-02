import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repositoryRoot, 'scripts', 'opencode-compatibility.json');

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('-')) throw new Error(`missing ${name}`);
  return value;
}

async function platformDefinition(platform) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const definition = manifest.platforms?.[platform];
  if (definition === undefined) throw new Error('platform is not in the compatibility manifest');
  return { manifest, definition };
}

async function extractArchive(archive, destination) {
  await mkdir(destination, { recursive: true });
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await execFileAsync('tar', ['-xf', archive, '-C', destination], { windowsHide: true });
    } else {
      await execFileAsync('unzip', ['-q', '-o', archive, '-d', destination], { windowsHide: true });
    }
    return;
  }
  await execFileAsync('tar', ['-xzf', archive, '-C', destination], { windowsHide: true });
}

async function findExecutable(root) {
  const expected = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.name === expected) return target;
    }
  }
  return undefined;
}

async function main() {
  const version = argument('--version');
  const platform = argument('--platform');
  const output = path.resolve(argument('--output'));
  const { manifest, definition } = await platformDefinition(platform);
  const asset = definition.versions?.[version];
  if (asset === undefined) throw new Error('version is not pinned for this platform');
  const url = `https://github.com/${manifest.releaseRepository}/releases/download/v${version}/${definition.archive}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('OpenCode release download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha512').update(bytes).digest('hex');
  if (digest !== asset.sha512) throw new Error('OpenCode release checksum mismatch');
  const archive = path.join(path.dirname(output), `opencode-${version}-${definition.archive}`);
  await writeFile(archive, bytes, { mode: 0o600 });
  await extractArchive(archive, output);
  const executable = await findExecutable(output);
  if (executable === undefined) throw new Error('OpenCode release executable is missing');
  if (process.platform !== 'win32') await chmod(executable, 0o755);
  process.stdout.write(`${JSON.stringify({ version, platform, sha512: digest, executable })}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'OpenCode release installation failed'}\n`);
  process.exitCode = 1;
}
