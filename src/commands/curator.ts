import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { SqliteDatabase } from '../db/adapter.js';
import {
  curateMemoryCandidates,
  formatCuratorCandidate,
  globalizeCuratorCandidate,
  type CuratorCandidate,
} from '../memory/curator.js';

export interface CuratorCommandOptions {
  workspace?: string;
  cwd?: string;
  limit?: number;
  entryId?: string;
  yes?: boolean;
  json?: boolean;
  skillReadyOnly?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface CuratorCommandResult {
  workspace: string | null;
  candidates: CuratorCandidate[];
  globalized: Array<{ entryId: string; globalEntryId: string; idempotent: boolean }>;
  truncated: boolean;
}

function write(output: NodeJS.WritableStream, value: string): void {
  output.write(`${value}\n`);
}

export async function runCuratorCommand(database: SqliteDatabase, options: CuratorCommandOptions = {}): Promise<CuratorCommandResult> {
  const listed = await curateMemoryCandidates(database, {
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.skillReadyOnly === undefined ? {} : { skillReadyOnly: options.skillReadyOnly }),
  });
  const candidates = options.entryId === undefined
    ? listed.candidates
    : listed.candidates.filter((candidate) => candidate.entryId === options.entryId);
  const globalized: CuratorCommandResult['globalized'] = [];
  const output = options.output ?? stdout;
  const print = (value: string): void => { if (options.json !== true) write(output, value); };

  if (options.json === true && options.yes !== true) {
    return { workspace: listed.workspace, candidates, globalized, truncated: listed.truncated };
  }
  if (candidates.length === 0) {
    print('汎用化候補はありません。');
    return { workspace: listed.workspace, candidates, globalized, truncated: listed.truncated };
  }

  const input = options.input ?? stdin;
  const interactive = options.yes !== true && (input as { isTTY?: boolean }).isTTY === true;
  const prompt = interactive ? createInterface({ input, output }) : undefined;
  try {
    for (const candidate of candidates) {
      print(formatCuratorCandidate(candidate));
      let confirmed = options.yes === true;
      if (prompt) {
        const answer = await prompt.question('この再生成ドラフトをGlobalに追加しますか？ [y/N] ');
        confirmed = /^(?:y|yes|はい)$/iu.test(answer.trim());
      } else if (!confirmed) {
        print('非対話モードのため追加しません。確認する場合は端末から実行するか --yes を指定してください。');
      }
      if (!confirmed || listed.workspace === null) continue;
      const result = globalizeCuratorCandidate(database, {
        workspace: listed.workspace,
        entryId: candidate.entryId,
        expectedRevision: candidate.revision,
      });
      globalized.push({ entryId: candidate.entryId, globalEntryId: result.global.id, idempotent: result.idempotent });
      print(`Globalに追加しました: ${result.global.id}${result.idempotent ? '（既存）' : ''}`);
    }
  } finally {
    prompt?.close();
  }
  return { workspace: listed.workspace, candidates, globalized, truncated: listed.truncated };
}
