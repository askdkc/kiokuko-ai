import path from 'node:path';
import { lstat, mkdir, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as z from 'zod/v4';
import { getPlatformDataDirectory, type PathEnvironment } from '../config/paths.js';
import { parseStrictJson } from '../setup/strict-json.js';
import { SourceFailure } from './process.js';

export const RIPWIRE_VERSION = '0.4.0';
// Enabled only by a reviewed, passing repository evaluation, never by downloaded data.
export const SOURCE_AUTO_ACCEPTED: boolean = false;
export const sourceConfigSchema = z.object({
  mode: z.enum(['auto', 'off']).default('auto'),
  binaryPath: z.string().max(4096).refine(p => path.isAbsolute(p) && !/[\p{Cc}\p{Cf}]/u.test(p)).optional(),
  timeoutMs: z.number().int().min(100).max(10_000).default(10_000),
  maxTokens: z.number().int().min(256).max(8_000).default(4_000),
  maxOutputBytes: z.number().int().min(1024).max(32 * 1024).default(32 * 1024),
}).strict();
export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export function sourceDirectory(environment: PathEnvironment = {}): string {
  return path.join(getPlatformDataDirectory(environment), 'source-context');
}
export function managedBinary(directory: string): string {
  return path.join(directory, `ripwire-${RIPWIRE_VERSION}`, 'ripwire');
}
/** Read small regular files without following links or opening a FIFO. */
export async function readSourceFile(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new SourceFailure('unsafe_file');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new SourceFailure('source_changed');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export async function readSourceConfig(directory: string): Promise<SourceConfig> {
  try {
    const raw = await readSourceFile(path.join(directory, 'config.json'), 16 * 1024);
    return sourceConfigSchema.parse(parseStrictJson(raw.toString('utf8'), {
      allowTrailingComma: false, disallowComments: true, allowEmptyContent: false,
    }, 'Invalid source context configuration'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sourceConfigSchema.parse({});
    throw new SourceFailure('invalid_configuration');
  }
}
/** Private directories may not be aliases or shared writable directories. */
export async function privateSourceDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())
    || await realpath(directory) !== path.join(await realpath(path.dirname(directory)), path.basename(directory)))
    throw new SourceFailure('unsafe_storage');
}
