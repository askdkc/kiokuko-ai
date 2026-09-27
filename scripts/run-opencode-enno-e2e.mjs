import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runHostContract } from './run-opencode-host-e2e.mjs';

export function createOpenCodeE2eEnvironment({ home, config, data }, inherited = process.env) {
  return { ...inherited, HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, KIOKUKO_DATA_DIR: data };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length > 2) {
    process.stdout.write(JSON.stringify({ results: [{ client: 'opencode', status: 'failed', reason: 'unexpected_argument' }] }) + '\n');
    process.exitCode = 1;
  } else if (!process.env.OPENCODE_BIN) {
    process.stdout.write(JSON.stringify({ results: [{ client: 'opencode', status: 'failed', reason: 'OPENCODE_BIN_required' }] }) + '\n');
    process.exitCode = 1;
  } else try {
    await runHostContract({ execution: true });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ client: 'opencode', status: 'failed', reason: error instanceof Error ? error.message : 'host_contract_failed' })}\n`);
    process.exitCode = 1;
  }
}
