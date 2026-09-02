import type { SqliteDatabase } from '../db/adapter.js';
import {
  answerAkinatorService,
  startAkinatorService,
} from './service.js';
import type {
  AnswerAkinatorInput,
  StartAkinatorInput,
} from './service.js';
import type { AkinatorResult } from './types.js';

export type { AnswerAkinatorInput, StartAkinatorInput } from './service.js';

export function startAkinator(
  database: SqliteDatabase,
  input: StartAkinatorInput,
): Promise<AkinatorResult> {
  return startAkinatorService(database, input);
}

export function answerAkinator(
  database: SqliteDatabase,
  input: AnswerAkinatorInput,
): Promise<AkinatorResult> {
  return answerAkinatorService(database, input);
}
