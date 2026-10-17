import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function readGitOrigin(repositoryRoot: string): string | undefined {
  try {
    const value = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Local origins are valid Git inputs, but are not a shared repository identity.
    // Let the existing binding/location/canonical-path resolver identify those clones.
    const local = path.isAbsolute(value) || /^\.\.?[/\\]/u.test(value)
      || !value.includes(':') || /^file:\/\//iu.test(value);
    return value && !local ? value : undefined;
  } catch {
    return undefined;
  }
}
