import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { readSourceFile } from './config.js';
import { findSecret } from '../memory/secrets.js';
import { runSourceProcess, SourceFailure } from './process.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.pyi', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.swift', '.java', '.rb', '.php', '.lua', '.ex', '.exs', '.sh', '.bash', '.md', '.markdown', '.json', '.toml', '.yaml', '.yml']);
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'coverage', '.codex', '.agents', '.orca', '.kiokuko.json', '.ripwire_notes']);
export interface SourceSnapshot { root: string; digest: string; files: Map<string, Buffer>; excluded: number }
export async function canonicalSourceRoot(cwd: string, signal: AbortSignal): Promise<string> {
  if (!path.isAbsolute(cwd) || /[\p{Cc}\p{Cf}]/u.test(cwd)) throw new KiokukoError('VALIDATION_ERROR', 'Source cwd must be an absolute directory');
  const directory = await realpath(cwd);
  const result = await runSourceProcess({ executable: '/usr/bin/git', args: ['rev-parse', '--show-toplevel'], cwd: directory, signal, stdoutLimit: 4096 });
  if (result.code !== 0) throw new SourceFailure('repository_unavailable');
  const root = await realpath(result.stdout.toString('utf8').trim());
  if (root === path.parse(root).root) throw new KiokukoError('SECURITY_REJECTION', 'Source root must be a repository below the filesystem root');
  return root;
}
/** Copy regular source bytes, never directory symlinks, submodules, converters or Git configuration. */
export async function sourceSnapshot(root: string, signal: AbortSignal): Promise<SourceSnapshot> {
  const listed = await runSourceProcess({ executable: '/usr/bin/git', args: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    cwd: root, signal, stdoutLimit: 8 * 1024 * 1024 });
  if (listed.code !== 0) throw new SourceFailure('repository_unavailable');
  const names = [...new Set(new TextDecoder('utf8', { fatal: true }).decode(listed.stdout).split('\0').filter(Boolean))].sort();
  if (names.length > 50_000) throw new SourceFailure('source_limit');
  const files = new Map<string, Buffer>(); let total = 0, excluded = 0;
  const directories = new Set<string>([root]);
  for (const name of names) {
    signal.throwIfAborted();
    if (path.isAbsolute(name) || /[\\\p{Cc}\p{Cf}]/u.test(name) || name.split('/').some(p => !p || p === '..' || p === '.'))
      throw new KiokukoError('SECURITY_REJECTION', 'Source path escapes repository');
    if (name.split('/').some(p => EXCLUDED.has(p) || p.startsWith('.env')) || !SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())) { excluded++; continue; }
    const absolute = path.join(root, name);
    const parent = path.dirname(absolute);
    // realpath must not lead through even an internal directory alias.
    if (!directories.has(parent)) {
      try { if (await realpath(parent) !== parent) { excluded++; continue; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      directories.add(parent);
    }
    const stat = await lstat(absolute).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) { excluded++; continue; }
    const bytes = await readSourceFile(absolute, 2 * 1024 * 1024);
    // Recheck the parent after reading; never forward bytes obtained through an alias.
    if (await realpath(parent) !== parent) throw new KiokukoError('SECURITY_REJECTION', 'Source directory changed during read');
    // Do not persist credential-shaped source literals in a mirror or upstream index cache.
    if (findSecret(bytes.toString('utf8'))) { excluded++; continue; }
    total += bytes.length;
    if (total > 128 * 1024 * 1024) throw new SourceFailure('source_limit');
    files.set(name, bytes);
  }
  return { root, files, excluded, digest: canonicalContentHash({ root, excluded,
    files: [...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]) }) };
}
