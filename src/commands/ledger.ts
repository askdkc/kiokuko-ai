import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { SqliteDatabase } from '../db/adapter.js';
import { exportLedgerArchive, importLedgerArchive } from '../ledger/archive.js';
import { inspectLedger, purgeLedgerTarget, PURGE_BACKUP_WARNING, type PurgeTargetType } from '../ledger/maintenance.js';
import { promoteLedgerProposal } from '../ledger/promotion.js';
import { successEnvelope } from '../serialization/envelope.js';

export interface LedgerCommandDependencies {
  withDatabase<T>(operation: (database: SqliteDatabase) => T | Promise<T>): Promise<T>;
}

function emit(json: boolean | undefined, operation: string, data: unknown, message: string): void {
  if (json) process.stdout.write(`${JSON.stringify(successEnvelope(operation, data))}\n`);
  else process.stdout.write(`${message}\n`);
}

function archiveCommands(parent: Command, dependencies: LedgerCommandDependencies): void {
  const archive = parent.command('archive').description('Export or import the ledger archive format');
  archive.command('export').requiredOption('--workspace <name>').requiredOption('--output <path>').option('--json').action(async (options: { workspace: string; output: string; json?: boolean }) => {
    const result = await dependencies.withDatabase((database) => exportLedgerArchive(database, { workspace: options.workspace }));
    await writeFile(options.output, result.content, 'utf8');
    emit(options.json, 'ledger.archive.export', { workspace: result.workspace, output: options.output, counts: result.counts, checksum: result.checksum }, `Ledger archive written to ${options.output}`);
  });
  archive.command('import').requiredOption('--input <path>').option('--workspace <name>').option('--dry-run').option('--json').action(async (options: { input: string; workspace?: string; dryRun?: boolean; json?: boolean }) => {
    const content = await readFile(options.input, 'utf8');
    const input: Parameters<typeof importLedgerArchive>[1] = { content, dryRun: options.dryRun === true };
    if (options.workspace !== undefined) input.workspace = options.workspace;
    const result = options.dryRun === true
      ? importLedgerArchive(undefined, input)
      : await dependencies.withDatabase((database) => importLedgerArchive(database, input));
    emit(options.json, 'ledger.archive.import', result, `Ledger archive ${options.dryRun ? 'checked' : 'imported'}`);
  });
}

export function registerLedgerCommands(cli: Command, dependencies: LedgerCommandDependencies): void {
  const ledger = cli.command('ledger').description('Inspect and maintain the append-only agent ledger');
  ledger.command('inspect').requiredOption('--workspace <name>').option('--json').action(async (options: { workspace: string; json?: boolean }) => {
    const result = await dependencies.withDatabase((database) => inspectLedger(database, { workspace: options.workspace }));
    emit(options.json, 'ledger.inspect', result, result.ok ? 'Ledger integrity: OK' : `Ledger integrity: ${result.findingCount} finding(s)`);
    if (!result.ok) process.exitCode = 8;
  });
  archiveCommands(ledger, dependencies);
  ledger.command('purge').requiredOption('--workspace <name>').requiredOption('--target-type <type>').requiredOption('--target-id <id>').requiredOption('--actor <actor>').option('--reason <text>').option('--purge-id <id>').option('--created-at <timestamp>').option('--confirm').option('--json').action(async (options: { workspace: string; targetType: string; targetId: string; actor: string; reason?: string; purgeId?: string; createdAt?: string; confirm?: boolean; json?: boolean }) => {
    const result = await dependencies.withDatabase((database) => purgeLedgerTarget(database, {
      workspace: options.workspace,
      targetType: options.targetType as PurgeTargetType,
      targetId: options.targetId,
      actor: options.actor,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      purgeId: options.purgeId ?? randomUUID(),
      createdAt: options.createdAt ?? new Date().toISOString(),
      confirmed: options.confirm === true,
    }));
    emit(options.json, 'ledger.purge', result, `Ledger target purged (${result.deletedCount}); ${PURGE_BACKUP_WARNING}`);
  });
  ledger.command('promote').requiredOption('--workspace <name>').requiredOption('--run-id <id>').requiredOption('--proposal-event-id <id>').option('--delivery-id <id>').requiredOption('--actor <actor>').option('--created-at <timestamp>').option('--confirm').option('--json').action(async (options: { workspace: string; runId: string; proposalEventId: string; deliveryId?: string; actor: string; createdAt?: string; confirm?: boolean; json?: boolean }) => {
    const result = await dependencies.withDatabase((database) => promoteLedgerProposal(database, {
      workspace: options.workspace,
      runId: options.runId,
      proposalEventId: options.proposalEventId,
      ...(options.deliveryId === undefined ? {} : { deliveryId: options.deliveryId }),
      actor: options.actor,
      createdAt: options.createdAt ?? new Date().toISOString(),
      confirmed: options.confirm === true,
    }));
    emit(options.json, 'ledger.promote', result, `Ledger proposal promoted as candidate ${result.entry.id}`);
  });
}
