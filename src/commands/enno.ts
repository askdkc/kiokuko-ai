import { Command } from 'commander';
import { KiokukoError } from '../errors.js';
import { ENNO_ROLES, type EnnoRole } from '../enno-oduno/types.js';
import {
  generateRoleDirective,
  blockedRoleResult,
  MAX_ROLE_INPUT_BYTES,
  parseRoleJson,
  serializeRoleOutput,
} from '../enno-oduno/role-runner.js';
import type { SqliteDatabase } from '../db/adapter.js';
import {
  decideAdapterContinuation,
  ENNO_ADAPTER_WARNING,
  ENNO_CLIENTS,
  failOpenAdapterOutput,
  renderOpenCodeDecision,
  type EnnoClient,
} from '../enno-oduno/adapters.js';
import { parseOpenCodeHookRequest } from '../opencode/hook-protocol.js';

async function readInputFromStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
    size += bytes.byteLength;
    if (size > MAX_ROLE_INPUT_BYTES) throw new KiokukoError('VALIDATION_ERROR', 'Enno role input is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseRole(value: string): EnnoRole {
  if (!ENNO_ROLES.includes(value as EnnoRole)) {
    throw new KiokukoError('VALIDATION_ERROR', `role must be one of: ${ENNO_ROLES.join(', ')}`);
  }
  return value as EnnoRole;
}

function parseClient(value: string): EnnoClient {
  if (!ENNO_CLIENTS.includes(value as EnnoClient)) {
    throw new KiokukoError('UNSUPPORTED_CLIENT', 'Only the OpenCode client is supported');
  }
  return value as EnnoClient;
}

export interface EnnoCommandDependencies {
  withDatabase?: <T>(operation: (database: SqliteDatabase) => T | Promise<T>) => Promise<T>;
}

export function registerEnnoCommand(root: Command, dependencies: EnnoCommandDependencies = {}): void {
  const enno = root.command('enno').description('Run Enno-Oduno role directive generation');
  enno.command('run')
    .description('Generate one strict JSON role directive without database, network, or command access')
    .requiredOption('--role <role>', 'enno-oduno, zenki, or goki')
    .requiredOption('--input-json <path>', 'Strict JSON input; v1 accepts stdin (-) only')
    .action(async (options: { role: string; inputJson: string }) => {
      let role: EnnoRole = 'enno-oduno';
      try {
        role = parseRole(options.role);
        if (options.inputJson !== '-') {
          throw new KiokukoError('VALIDATION_ERROR', 'Enno role input must be read from stdin with --input-json -');
        }
        const directive = generateRoleDirective(role, parseRoleJson(await readInputFromStdin()));
        process.stdout.write(serializeRoleOutput(directive));
      } catch (error) {
        process.stderr.write('Enno role execution blocked\n');
        process.stdout.write(serializeRoleOutput(blockedRoleResult(role, error)));
        process.exitCode = 8;
      }
    });

  enno.command('hook')
    .description('Evaluate one OpenCode completion event')
    .requiredOption('--client <client>', 'opencode')
    .requiredOption('--input-json <path>', 'Strict JSON input; v1 accepts stdin (-) only')
    .action(async (options: { client: string; inputJson: string }) => {
      const client = parseClient(options.client);
      if (options.inputJson !== '-') {
        process.stderr.write(`${ENNO_ADAPTER_WARNING}\n`);
        process.stdout.write(serializeRoleOutput(failOpenAdapterOutput(client)));
        return;
      }
      try {
        if (dependencies.withDatabase === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Enno adapter database is unavailable');
        const input = parseOpenCodeHookRequest(parseRoleJson(await readInputFromStdin()));
        const decision = await dependencies.withDatabase((database) => decideAdapterContinuation(database, client, input));
        const output = renderOpenCodeDecision(decision);
        process.stdout.write(serializeRoleOutput(output));
      } catch (error) {
        process.stderr.write(`${ENNO_ADAPTER_WARNING}\n`);
        const code = error instanceof KiokukoError && error.code === 'CONFLICT'
          ? 'version_mismatch'
          : error instanceof KiokukoError && error.code === 'VALIDATION_ERROR'
            ? 'invalid_response'
            : 'adapter_unavailable';
        process.stdout.write(serializeRoleOutput(failOpenAdapterOutput(client, code)));
      }
    });
}
