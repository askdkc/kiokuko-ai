import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repositoryRoot, 'scripts', 'opencode-compatibility.json');

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const retryableNetworkCodes = new Set([
  'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

/** Retry only the download; verification and installation are never replayed. */
export async function downloadRelease(url, {
  fetchImpl = fetch,
  wait = delay,
  log = message => process.stderr.write(`${message}\n`),
  timeoutMs = 60_000,
} = {}) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let reason;
    let retryable;
    let retryDelay = 1_000 * attempt;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      reason = `HTTP ${response.status}`;
      retryable = retryableStatuses.has(response.status);
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter !== null) {
        const milliseconds = /^\d+$/u.test(retryAfter)
          ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(milliseconds) && milliseconds > 60_000) retryable = false;
        else if (Number.isFinite(milliseconds)) retryDelay = Math.max(retryDelay, milliseconds);
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      const timedOut = error?.name === 'TimeoutError';
      retryable = retryableNetworkCodes.has(code) || timedOut
        || (code === undefined && error instanceof TypeError && error.message === 'fetch failed');
      reason = retryableNetworkCodes.has(code) ? code : timedOut ? 'timeout' : 'network error';
    }
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`OpenCode release download failed (${reason}; attempt ${attempt}/${maxAttempts})`);
    }
    log(`OpenCode release download attempt ${attempt}/${maxAttempts} failed (${reason}); retrying in ${retryDelay}ms`);
    await wait(retryDelay);
  }
}

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
  const bytes = await downloadRelease(url);
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

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'OpenCode release installation failed'}\n`);
  process.exitCode = 1;
}
