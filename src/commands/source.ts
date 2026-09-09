import type { Command } from 'commander';
import path from 'node:path';
import { writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sourceDirectory, readSourceConfig, sourceConfigSchema, privateSourceDirectory } from '../source-context/config.js';
import { setupSource } from '../source-context/install.js';
import { SourceContextService, sourceStatus } from '../source-context/service.js';
import { successEnvelope } from '../serialization/envelope.js';

async function withSourceCancellation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException('Source operation cancelled', 'AbortError'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try { return await operation(controller.signal); }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

export function registerSourceCommands(cli: Command): void {
  const source = cli.command('source').description('Optional local ripwire source investigation');
  const emit = (operation: string, json: boolean | undefined, result: unknown) =>
    process.stdout.write(`${JSON.stringify(json ? successEnvelope(operation, result) : result, null, json ? undefined : 2)}\n`);
  source.command('setup').description('Download and verify the pinned ripwire binary only').option('--json', 'Emit JSON')
    .action(async options => { emit('source.setup', options.json,
      await withSourceCancellation(signal => setupSource(sourceDirectory(), { signal }))); });
  source.command('status').description('Probe compatibility and automatic-use eligibility').option('--json', 'Emit JSON')
    .action(async options => { emit('source.status', options.json, await sourceStatus()); });
  source.command('configure').description('Configure optional source investigation; never installs software')
    .option('--mode <mode>', 'auto or off').option('--binary <path>', 'Explicit absolute ripwire binary path')
    .option('--managed', 'Select the Kiokuko-managed binary').option('--timeout-ms <number>', 'Total investigation deadline, at most 10000')
    .option('--max-tokens <number>', 'Upstream token target').option('--max-output-bytes <number>', 'Returned JSON byte limit')
    .option('--json', 'Emit JSON').action(async options => {
      const directory = sourceDirectory();
      const current = await readSourceConfig(directory);
      const config = sourceConfigSchema.parse({ ...current, ...(options.mode ? { mode: options.mode } : {}),
        ...(options.binary ? { binaryPath: options.binary } : {}),
        ...(options.timeoutMs ? { timeoutMs: Number(options.timeoutMs) } : {}),
        ...(options.maxTokens ? { maxTokens: Number(options.maxTokens) } : {}),
        ...(options.maxOutputBytes ? { maxOutputBytes: Number(options.maxOutputBytes) } : {}) });
      if (options.managed) delete config.binaryPath;
      await privateSourceDirectory(directory);
      const temp = path.join(directory, `.config-${randomUUID()}`);
      try {
        await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temp, path.join(directory, 'config.json'));
      } finally { await rm(temp, { force: true }); }
      emit('source.configure', options.json, { mode: config.mode, source: config.binaryPath ? 'explicit' : 'managed' });
    });
  source.command('inspect').description('Read a bounded source map; suggestions are not test evidence')
    .requiredOption('--task <task>', 'Original task').option('--query <query>', 'Optional search wording')
    .option('--cwd <path>', 'Repository directory', process.cwd()).option('--max-tokens <number>', 'Token target')
    .option('--json', 'Emit JSON').action(async options => {
      const result = await withSourceCancellation(signal => new SourceContextService().inspect({ cwd: path.resolve(options.cwd), task: options.task,
        ...(options.query === undefined ? {} : { query: options.query }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: Number(options.maxTokens) }) }, { signal }));
      emit('source.inspect', options.json, result);
      if (result.status === 'unavailable') process.exitCode = 2;
    });
}
