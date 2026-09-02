import { migrateDatabase } from '../../src/db/migrate.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';

const databasePath = process.env.KIOKUKO_TEST_DATABASE;
const worker = Number(process.env.KIOKUKO_TEST_WORKER ?? '0');
if (!databasePath || !Number.isInteger(worker)) throw new Error('KIOKUKO_TEST_DATABASE and worker are required');

const database = openConnection(databasePath);
try {
  migrateDatabase(database);
  for (let index = 0; index < 10; index += 1) {
    recordEntry(database, {
      workspace: 'project:concurrency',
      kind: 'lesson',
      title: `worker ${worker} entry ${index}`,
      body: `concurrent write ${worker}/${index}`,
      tags: ['concurrency'],
      createdBy: `worker-${worker}`,
    });
  }
} finally {
  database.close();
}
