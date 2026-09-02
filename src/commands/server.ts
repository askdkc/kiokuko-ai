import type { Command } from 'commander';
import { KiokukoError } from '../errors.js';
import { successEnvelope } from '../serialization/envelope.js';
import { getServerStatus, type ServerStatus, type ServerStatusOptions } from './server-status.js';
import {
  runServeCommand,
  type ServeCommandDependencies,
  type ServeCommandOptions,
  type ServeStartup,
} from './serve.js';

export type ServerStatusReader = (options: ServerStatusOptions) => PromiseLike<ServerStatus>;
export type ServerOutputWriter = (text: string) => void;

export interface ServerCommandDependencies extends ServeCommandDependencies {
  readonly getServerStatus?: ServerStatusReader;
  readonly stdout?: ServerOutputWriter;
  readonly onServeStarted?: () => void;
}

function writeOutput(dependencies: ServerCommandDependencies, text: string): void {
  (dependencies.stdout ?? ((value: string) => process.stdout.write(value)))(text);
}

function writeServeStartup(
  dependencies: ServerCommandDependencies,
  options: { readonly json?: boolean },
  startup: ServeStartup,
): void {
  if (options.json === true) {
    writeOutput(dependencies, `${JSON.stringify(successEnvelope('serve', startup))}\n`);
    dependencies.onServeStarted?.();
    return;
  }
  writeOutput(dependencies, `${startup.url}\n`);
  dependencies.onServeStarted?.();
}

function safeStatusError(error: unknown): KiokukoError {
  if (error instanceof KiokukoError) {
    const messages: Record<string, string> = {
      VALIDATION_ERROR: 'Server runtime descriptor is invalid',
      SECURITY_REJECTION: 'Server runtime descriptor was rejected',
      SERVICE_UNAVAILABLE: 'Unable to query server status',
    };
    return new KiokukoError(error.code, messages[error.code] ?? 'Unable to query server status');
  }
  return new KiokukoError('SERVICE_UNAVAILABLE', 'Unable to query server status');
}

function publicStatus(status: ServerStatus): ServerStatus {
  if (!status.running && !status.stale) return { running: false, stale: false };
  const descriptor = {
    protocolVersion: status.descriptor.protocolVersion,
    instanceId: status.descriptor.instanceId,
    pid: status.descriptor.pid,
    baseUrl: status.descriptor.baseUrl,
    databaseFingerprint: status.descriptor.databaseFingerprint,
    startedAt: status.descriptor.startedAt,
  };
  if (status.running) return { running: true, stale: false, descriptor };
  return { running: false, stale: true, descriptor };
}

export async function runServerStatusCommand(
  options: ServerStatusOptions = {},
  dependencies: Pick<ServerCommandDependencies, 'getServerStatus'> = {},
): Promise<ServerStatus> {
  try {
    return publicStatus(await (dependencies.getServerStatus ?? getServerStatus)(options));
  } catch (error) {
    throw safeStatusError(error);
  }
}

export function registerServerCommands(cli: Command, dependencies: ServerCommandDependencies = {}): Command {
  cli.command('serve')
    .description('Start the Kiokuko server in the foreground')
    .option('--host <host>', 'Loopback host', '127.0.0.1')
    .option('--port <number>', 'HTTP port', '0')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { host: string; port: string; json?: boolean }) => {
      const serveOptions: ServeCommandOptions = {
        host: options.host,
        port: Number(options.port),
      };
      await runServeCommand(serveOptions, {
        ...dependencies,
        onStarted: (startup) => writeServeStartup(dependencies, options, startup),
      });
    });

  const server = cli.command('server').description('Inspect the Kiokuko server');
  server.command('status')
    .description('Show the Kiokuko server status')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { json?: boolean }) => {
      const status = await runServerStatusCommand({}, dependencies);
      if (options.json === true) {
        writeOutput(dependencies, `${JSON.stringify(successEnvelope('server.status', status))}\n`);
        return;
      }
      if (status.running) {
        writeOutput(dependencies, `${status.descriptor.baseUrl}\n`);
      } else if (status.stale) {
        writeOutput(dependencies, 'stale\n');
      } else {
        writeOutput(dependencies, 'not running\n');
      }
    });
  return server;
}
