import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';

// Locate the executable used by the required check. API and recording behavior
// are verified by that check, rather than inferred from a release label.
export async function resolveVerificationExecutable(capability, { root, environment, declaration }) {
  const recorder = capability === 'agenticreplay-managed'
    ? (await import('./agenticreplay-dependency.mjs')).managedAgenticReplay(root) : undefined;
  const binary = environment[declaration?.environment] ?? recorder?.binary ?? declaration?.binary ?? capability;
  const candidates = path.isAbsolute(binary) ? [binary] : (environment.PATH ?? '').split(path.delimiter)
    .map(directory => path.join(directory, process.platform === 'win32' ? binary + '.cmd' : binary));
  let location = candidates.find(file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } });
  if (!location) throw new Error(`Required executable is missing: ${capability}`);
  if (capability === 'opencode') {
    const { resolveOpenCodeBinary } = await import('./run-opencode-host-e2e.mjs');
    location = await resolveOpenCodeBinary(location);
  }
  return realpathSync(location);
}
