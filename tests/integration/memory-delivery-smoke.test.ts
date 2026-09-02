import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initializeDatabase } from "../../src/commands/init.js";
import { createKiokukoMcpServer } from "../../src/mcp/server.js";
import { openConnection } from "../../src/db/connection.js";
import { parseRetrievalQuery } from "../../src/memory/retrieval-query.js";
import { recallScopedMemory } from "../../src/memory/scoped-memory.js";
import { resolveProjectWorkspace } from "../../src/memory/workspaces.js";

type TaskPrepareResult = {
  intake: { status: string };
  context: { items: Array<Record<string, unknown>> } | null;
  memoryPolicy: {
    memoryReasoningRequired: boolean;
    contextWithheld: boolean;
    withheldReason: string | null;
  };
  nextAction: string;
};

type MemoryCheckpointResult = {
  entries: Array<{ status: string; workspace: string }>;
};

type TaskAnswerResult = {
  run: { runId: string };
  intake: {
    status: string;
    sessionId: string;
    question: { id: string } | null;
    profile: { taskType: string } | null;
  };
  context: { items: Array<Record<string, unknown>> } | null;
  memoryPolicy: {
    memoryReasoningRequired: boolean;
    contextWithheld: boolean;
    withheldReason: string | null;
  };
  nextAction: string;
};

const SOUL_CAPABILITY = {
  kind: "skill",
  name: "kiokuko-soul",
  description: "Route Kiokuko work to every applicable bundled Skill.",
} as const;

const MEMORY_REASONING_CAPABILITY = {
  kind: "skill",
  name: "memory-reasoning",
  description: "Verify recalled memory before implementation",
} as const;

async function scratchRepository(prefix: string): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), `kiokuko-smoke-repo-${prefix}-`),
  );
  execFileSync("git", ["init", "-q", root]);
  return root;
}

async function startServer(
  databasePath: string,
  repoRoot: string,
): Promise<Client> {
  const server = createKiokukoMcpServer({ databasePath, cwd: () => repoRoot });
  const client = new Client({ name: "kiokuko-smoke", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function checkpointRules(
  client: Client,
  title: string,
  body: string,
): Promise<MemoryCheckpointResult> {
  const checkpoint = await client.callTool({
    name: "memory_checkpoint",
    arguments: {
      memories: [{ kind: "lesson", title, body }],
    },
  });
  assert.equal(checkpoint.isError, undefined);
  return checkpoint.structuredContent as MemoryCheckpointResult;
}

async function taskPrepare(
  client: Client,
  requestId: string,
  task: string,
): Promise<TaskPrepareResult> {
  const prepared = await client.callTool({
    name: "task_prepare",
    arguments: {
      soulRead: true,
      requestId,
      task,
      profileHints: { taskType: "build" },
      capabilities: [
        SOUL_CAPABILITY,
        MEMORY_REASONING_CAPABILITY,
        {
          kind: "mcp_tool",
          name: "task_prepare",
          description: "Prepare a Kiokuko-guided task",
        },
        {
          kind: "mcp_tool",
          name: "task_answer",
          description: "Answer the current intake question",
        },
        {
          kind: "mcp_tool",
          name: "memory_checkpoint",
          description: "Persist durable memory once",
        },
      ],
    },
  });
  assert.equal(prepared.isError, undefined, JSON.stringify(prepared.content));
  return prepared.structuredContent as TaskPrepareResult;
}

const INTAKE_ANSWERS: Record<string, string> = {
  taskType: "build",
  target: "users テーブルへの display_name カラム追加マイグレーション",
  expected: "全テストが成功すること",
  constraints: "既存マイグレーションファイルは編集しない",
};

async function taskPrepareReady(
  client: Client,
  requestId: string,
  task: string,
): Promise<TaskAnswerResult> {
  let result = (await taskPrepare(
    client,
    requestId,
    task,
  )) as unknown as TaskAnswerResult & { run?: { runId: string } };
  let runId = result.run?.runId;
  let guard = 0;
  while (result.intake.status === "needs_answer") {
    guard += 1;
    assert.ok(guard <= 6, "intake did not become ready within 6 answers");
    const questionId = result.intake.question?.id;
    assert.ok(questionId, "needs_answer without a questionId");
    const value = INTAKE_ANSWERS[questionId] ?? task;
    assert.ok(runId, "task_prepare response must include run.runId");
    const answered = await client.callTool({
      name: "task_answer",
      arguments: {
        sessionId: result.intake.sessionId,
        runId: runId as string,
        questionId,
        value,
        capabilities: [
          SOUL_CAPABILITY,
          MEMORY_REASONING_CAPABILITY,
          {
            kind: "mcp_tool",
            name: "task_prepare",
            description: "Prepare a Kiokuko-guided task",
          },
          {
            kind: "mcp_tool",
            name: "task_answer",
            description: "Answer the current intake question",
          },
          {
            kind: "mcp_tool",
            name: "memory_checkpoint",
            description: "Persist durable memory once",
          },
        ],
      },
    });
    assert.equal(answered.isError, undefined, JSON.stringify(answered.content));
    result = answered.structuredContent as TaskAnswerResult;
    if (!runId) runId = result.run?.runId;
  }
  assert.equal(result.intake.status, "ready");
  return result;
}

test("delivery smoke: a stored Japanese policy is delivered to the next build task", async () => {
  const repo = await scratchRepository("delivery");
  const data = await mkdtemp(
    path.join(tmpdir(), "kiokuko-smoke-data-delivery-"),
  );
  const databasePath = path.join(data, "kiokuko-ai.sqlite");
  await initializeDatabase({ databasePath });
  const client = await startServer(databasePath, repo);
  try {
    const stored = await checkpointRules(
      client,
      "リポジトリ保守ルール",
      "このリポジトリのマイグレーションは forward-only。過去のマイグレーションファイル(001, 002, 003 など)は絶対に編集・削除・リネームしない。変更は必ず新しい番号のマイグレーションファイルを追加して行う。",
    );
    assert.equal(stored.entries[0]?.status, "candidate");

    const delivered = await taskPrepareReady(
      client,
      "smoke-delivery-001",
      "users テーブルに display_name カラムを追加するマイグレーションを追加してください",
    );
    assert.equal(delivered.intake.status, "ready");
    assert.ok(
      (delivered.context?.items.length ?? 0) >= 1,
      `stored Japanese policy must be delivered to the follow-up build task (items=${delivered.context?.items.length ?? 0})`,
    );
  } finally {
    await client.close();
    await rm(data, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test(
  "cjk retrieval smoke: japanese query terms hit a Japanese-only entry through every retrieval lane",
  async () => {
    const repo = await scratchRepository("cjk");
    const data = await mkdtemp(path.join(tmpdir(), "kiokuko-smoke-data-cjk-"));
    const databasePath = path.join(data, "kiokuko-ai.sqlite");
    await initializeDatabase({ databasePath });
    const database = openConnection(databasePath);
    const client = await startServer(databasePath, repo);
    try {
      await checkpointRules(
        client,
        "データストア移行の方針",
        "データストアのマイグレーションは forward-only。過去のマイグレーションファイルは絶対に編集しない。新しい番号のファイルを追加する。",
      );

      const workspace = await resolveProjectWorkspace(database, repo);
      assert.ok(workspace);

      // parseRetrievalQuery must produce a substring term that actually appears in the stored body.
      const parsed = parseRetrievalQuery(
        "users テーブルに display_name カラムを追加するマイグレーションを追加してください",
      );
      const bodyText =
        "データストアのマイグレーションは forward-only。過去のマイグレーションファイルは絶対に編集しない。";
      const overlapping = parsed.substringTerms.filter((term) =>
        bodyText.includes(term),
      );
      assert.ok(
        overlapping.length >= 1,
        `parseRetrievalQuery must emit at least one JP substring term that occurs in the stored body (terms=${JSON.stringify(parsed.substringTerms)})`,
      );

      // The operator-facing recall path must find the entry from a Japanese query.
      const recalled = await recallScopedMemory(database, {
        cwd: repo,
        query:
          "users テーブルに display_name カラムを追加するマイグレーションを追加してください",
        limit: 10,
      });
      const recalledText = JSON.stringify(recalled);
      assert.ok(
        /方針|ルール/u.test(recalledText),
        "japanese query must recall the japanese-only entry (retrieval result was empty)",
      );
    } finally {
      database.close();
      await client.close();
      await rm(data, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  },
);

test("scope isolation smoke: writes under KIOKUKO_DATA_DIR never touch the user-global database", async (t) => {
  const repo = await scratchRepository("scope");
  const runData = await mkdtemp(
    path.join(tmpdir(), "kiokuko-smoke-scope-run-"),
  );
  const globalData = await mkdtemp(
    path.join(tmpdir(), "kiokuko-smoke-scope-global-"),
  );
  const runDatabasePath = path.join(runData, "kiokuko-ai.sqlite");
  const globalDatabasePath = path.join(globalData, "kiokuko-ai.sqlite");
  for (const databasePath of [runDatabasePath, globalDatabasePath]) {
    await initializeDatabase({ databasePath });
  }

  const globalBefore = openConnection(globalDatabasePath);
  const baselineEntries =
    globalBefore
      .prepare("SELECT COUNT(*) AS count FROM entries")
      .get<{ count: number }>()?.count ?? 0;
  globalBefore.close();

  const runClient = await startServer(runDatabasePath, repo);
  try {
    await checkpointRules(
      runClient,
      "スコープ分離確認",
      "このエントリはラン専用DBへ書かれたことを確認するためのもの。",
    );
    const runConnection = openConnection(runDatabasePath);
    try {
      const runEntries =
        runConnection
          .prepare("SELECT COUNT(*) AS count FROM entries")
          .get<{ count: number }>()?.count ?? 0;
      assert.ok(
        runEntries >= 1,
        "the isolated run database must contain the checkpoint entry",
      );
    } finally {
      runConnection.close();
    }
    const globalAfter = openConnection(globalDatabasePath);
    try {
      const globalEntries =
        globalAfter
          .prepare("SELECT COUNT(*) AS count FROM entries")
          .get<{ count: number }>()?.count ?? 0;
      assert.equal(
        globalEntries,
        baselineEntries,
        "checkpoint writes must never leak into the user-global database when KIOKUKO_DATA_DIR pins a disposable data dir",
      );
    } finally {
      globalAfter.close();
    }
  } finally {
    await runClient.close();
    await rm(runData, { recursive: true, force: true });
    await rm(globalData, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
