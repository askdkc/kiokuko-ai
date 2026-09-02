import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash } from '../serialization/validate.js';

export const REPOSITORY_STATE_POLICY_VERSION = 1;
const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_STABILITY_ATTEMPTS = 3;
const FALLBACK_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'coverage']);

export interface RepositoryStateSnapshot {
  policyVersion: typeof REPOSITORY_STATE_POLICY_VERSION;
  digest: string;
  fileCount: number;
}

function gitOutput(root: string, args: string[]): Buffer | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function nulPaths(output: Buffer): string[] {
  return output.toString('utf8').split('\0').filter((value) => value.length > 0);
}

function nestedGitRepository(directory: string): boolean {
  const topLevel = gitOutput(directory, ['rev-parse', '--show-toplevel'])?.toString('utf8').trim();
  if (topLevel === undefined || topLevel.length === 0) return false;
  try {
    return realpathSync(topLevel) === realpathSync(directory);
  } catch {
    return false;
  }
}

function fileProjection(root: string, relativePath: string, ancestors: ReadonlySet<string>): Record<string, unknown> {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) {
    throw new KiokukoError('SECURITY_REJECTION', 'Repository snapshot path escapes the canonical root');
  }
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new KiokukoError('SECURITY_REJECTION', 'Repository snapshot path escapes the canonical root');
  }
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined) return { path: relativePath, type: 'missing' };
  if (stat.isSymbolicLink()) return { path: relativePath, type: 'symlink', mode: stat.mode, target: readlinkSync(absolute) };
  if (stat.isDirectory()) {
    const nestedRoot = realpathSync(absolute);
    if (nestedGitRepository(nestedRoot)) {
      if (ancestors.has(nestedRoot)) throw new KiokukoError('INTEGRITY_ERROR', 'Repository snapshot contains a recursive Git repository');
      const nested = captureStableRepositoryState(nestedRoot, new Set([...ancestors, nestedRoot]));
      return {
        path: relativePath,
        type: 'git_repository',
        mode: stat.mode,
        policyVersion: nested.policyVersion,
        contentDigest: nested.digest,
        nestedFileCount: nested.fileCount,
      };
    }
    return { path: relativePath, type: 'directory', mode: stat.mode };
  }
  if (!stat.isFile()) return { path: relativePath, type: 'other', mode: stat.mode };
  if (stat.size > MAX_FILE_BYTES) throw new KiokukoError('SECURITY_REJECTION', 'Repository snapshot file exceeds the safety limit');
  return {
    path: relativePath,
    type: 'file',
    mode: stat.mode,
    contentDigest: canonicalContentHash(readFileSync(absolute).toString('base64')),
  };
}

function fallbackPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && FALLBACK_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
      else paths.push(relative);
      if (paths.length > MAX_FILES) throw new KiokukoError('SECURITY_REJECTION', 'Repository snapshot exceeds the file-count safety limit');
    }
  };
  visit(root);
  return paths.sort();
}

function captureRepositoryStateOnce(root: string, ancestors: ReadonlySet<string>): RepositoryStateSnapshot {
  const trackedAndUntracked = gitOutput(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const paths = trackedAndUntracked === undefined
    ? fallbackPaths(root)
    : [...new Set(nulPaths(trackedAndUntracked))].sort();
  if (paths.length > MAX_FILES) throw new KiokukoError('SECURITY_REJECTION', 'Repository snapshot exceeds the file-count safety limit');
  const head = gitOutput(root, ['rev-parse', '--verify', 'HEAD'])?.toString('utf8').trim() ?? null;
  const index = gitOutput(root, ['ls-files', '-s', '-z'])?.toString('base64') ?? null;
  const status = gitOutput(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])?.toString('base64') ?? null;
  const files = paths.map((relativePath) => fileProjection(root, relativePath, ancestors));
  const fileCount = files.reduce((count, file) => (
    count + 1 + (typeof file.nestedFileCount === 'number' ? file.nestedFileCount : 0)
  ), 0);
  if (fileCount > MAX_FILES) throw new KiokukoError('SECURITY_REJECTION', 'Repository snapshot exceeds the file-count safety limit');
  return {
    policyVersion: REPOSITORY_STATE_POLICY_VERSION,
    digest: canonicalContentHash({
      policyVersion: REPOSITORY_STATE_POLICY_VERSION,
      repositoryIdentity: canonicalContentHash(root),
      head,
      index,
      status,
      files,
    }),
    fileCount,
  };
}

function captureStableRepositoryState(root: string, ancestors: ReadonlySet<string>): RepositoryStateSnapshot {
  let previous: RepositoryStateSnapshot | undefined;
  for (let attempt = 0; attempt < MAX_STABILITY_ATTEMPTS; attempt += 1) {
    const current = captureRepositoryStateOnce(root, ancestors);
    if (previous !== undefined && previous.digest === current.digest && previous.fileCount === current.fileCount) return current;
    previous = current;
  }
  throw new KiokukoError('CONFLICT', 'Repository changed while its verification state was being captured');
}

export function captureRepositoryState(repositoryRoot: string): RepositoryStateSnapshot {
  const root = realpathSync(repositoryRoot);
  return captureStableRepositoryState(root, new Set([root]));
}
