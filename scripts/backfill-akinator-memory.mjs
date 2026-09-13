import path from 'node:path';
import { lstatSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openConnection, databaseFileIdentity } from '../dist/db/connection.js';
import { migrateDatabase } from '../dist/db/migrate.js';
import { backfillProfiles, resetProfileProjection } from '../dist/akinator/profile-memory-store.js';

const { values } = parseArgs({ options: { rebuild: { type: 'boolean', default: false }, database: { type: 'string' }, workspace: { type: 'string' }, 'batch-size': { type: 'string', default: '100' } } });
if (!values.database || !path.isAbsolute(values.database) || !lstatSync(values.database).isFile()) {
  throw new Error('--database must name an existing regular SQLite file using an absolute path');
}
const batchSize = Number(values['batch-size']);
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('--batch-size must be between 1 and 1000');
const database = openConnection(values.database, { expectedFileIdentity: databaseFileIdentity(values.database) });
try {
  migrateDatabase(database);
  const workspaces = values.workspace ? [values.workspace] : database.prepare('SELECT workspace FROM repositories ORDER BY workspace').all().map(row => row.workspace);
  let processed = 0;
  for (const workspace of workspaces) {
    if (values.rebuild) resetProfileProjection(database, workspace);
    let batch;
    do {
      batch = backfillProfiles(database, workspace, batchSize);
      processed += batch.processed;
      // Each batch commits separately; allow termination between batches without a partial projection.
      await new Promise(resolve => setImmediate(resolve));
    } while (!batch.complete);
  }
  process.stdout.write(JSON.stringify({ complete: true, workspaces: workspaces.length, processed }) + '\n');
} finally { database.close(); }
