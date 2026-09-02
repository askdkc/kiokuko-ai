import { useRepository } from '../../src/commands/use.js';

const root = process.env.KIOKUKO_TEST_ROOT;
const databasePath = process.env.KIOKUKO_TEST_DATABASE;
if (!root || !databasePath) throw new Error('KIOKUKO_TEST_ROOT and database are required');
await useRepository({ root, databasePath });
