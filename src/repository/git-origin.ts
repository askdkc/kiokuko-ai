import { execFileSync } from 'node:child_process';

export function readGitOrigin(repositoryRoot: string): string | undefined {
  try {
    const value = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
