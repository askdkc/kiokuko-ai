import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { chunkSkillMarkdown } from '../../src/skills/chunking.js';
import { importSkillSnapshot, markExternalSkillRefreshFailure, recordDiscoveredSkill } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate, SkillRegistryProvider } from '../../src/skills/types.js';
import { startWebServer } from '../../src/web/server.js';
import { externalSkillEntrySummaryIsValid, externalSkillListItemIsValid } from '../../src/web/ui.js';
import { requirementForOfficialSkill } from '../../src/skills/official-catalog.js';
import { authorizeSkillMaterialization } from '../../src/skills/materialization-authority.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS } from '../../src/skills/materialization-service.js';

interface HttpTestResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function openCurrentDatabase(databasePath: string) {
  await initializeDatabase({ databasePath });
  return openConnection(databasePath);
}

function sourceJsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function sourceRawJsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function requestWithHeaders(url: string, options: { method?: string; headers: Record<string, string> }): Promise<HttpTestResponse> {
  return new Promise<HttpTestResponse>((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function assertValidationResponse(response: Response): Promise<void> {
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { code: 'VALIDATION_ERROR', message: 'Request is invalid', details: {} },
  });
}

test('External Skills UI DTO validation rejects malformed fields and mapping entries', () => {
  const skill = {
    skillId: 'github:owner/repo:MixedCase', provider: 'fixture', sourceType: 'github', sourceLocator: 'owner/repo', slug: 'MixedCase', name: 'MixedCase',
    installUrl: 'https://github.com/owner/repo', officialStatus: 'registry-only', duplicate: false, installs: 1, state: 'imported',
    sourceWorkspace: 'external-skills:github:owner-repo-fixture', sourceCommit: 'd'.repeat(40), snapshotHash: 'a'.repeat(64),
    metadata: { documents: 1, technology: 'Svelte' }, auditStatus: 'passed', generation: 1,
    firstSeenAt: '2026-08-25T00:00:00.000Z', lastSeenAt: '2026-08-25T00:00:00.000Z', lastCheckedAt: '2026-08-25T00:00:00.000Z', disabledAt: null,
  };
  assert.equal(externalSkillListItemIsValid(skill), true);
  assert.equal(externalSkillListItemIsValid({ ...skill, sourceCommit: 42 }), false);
  assert.equal(externalSkillListItemIsValid({ ...skill, slug: 'mixedcase' }), false);
  assert.equal(externalSkillListItemIsValid({ ...skill, metadata: { documents: 1, technology: 'Svelte', hidden: true } }), false);
  assert.equal(externalSkillListItemIsValid({ ...skill, officialStatus: ['registry-only'] }), false);
  assert.equal(externalSkillListItemIsValid({ ...skill, state: ['imported'] }), false);
  assert.equal(externalSkillListItemIsValid({ ...skill, auditStatus: ['passed'] }), false);
  const entry = { entryId: 'entry-1', revision: 1, sourcePath: 'skills/MixedCase/SKILL.md', chunkIndex: 0, primary: true, active: true };
  assert.equal(externalSkillEntrySummaryIsValid(entry), true);
  assert.equal(externalSkillEntrySummaryIsValid({ ...entry, chunkIndex: -1 }), false);
  assert.equal(externalSkillEntrySummaryIsValid({ ...entry, sourcePath: '../SKILL.md' }), false);
  assert.equal(externalSkillEntrySummaryIsValid({ ...entry, body: 'must not be exposed' }), false);
});

test('External Skills web API is authenticated, bounded, and stateful', async () => {
  const initialCommit = `eb00c011${'0'.repeat(32)}`;
  const refreshedCommit = `eb00c012${'0'.repeat(32)}`;
  const blockedCommit = `eb00c013${'0'.repeat(32)}`;
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-web-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = await openCurrentDatabase(databasePath);
  const candidate: SkillCandidate = {
    id: 'fixture:sveltejs/ai-tools:svelte-code-writer', provider: 'fixture', name: 'Svelte Code Writer', slug: 'svelte-code-writer', source: 'sveltejs/ai-tools', sourceType: 'github', installUrl: 'https://github.com/sveltejs/ai-tools', installs: 0, duplicate: false, officialStatus: 'catalog-verified',
  };
  const snapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: initialCommit,
    files: [{ path: 'skills/svelte-code-writer/SKILL.md', content: '---\nname: Svelte Code Writer\ndescription: safe\n---\n# Svelte\n\nReference body.', primary: true }],
  });
  importSkillSnapshot(database, snapshot, chunkSkillMarkdown({ skillName: snapshot.frontmatter.name, sourcePath: snapshot.files[0]!.path, markdown: snapshot.files[0]!.content, summary: snapshot.frontmatter.description, stripFrontmatter: true }), requirementForOfficialSkill(candidate));
  database.close();

  const web = await startWebServer({ databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(directory, 'runtime') } });
  try {
    const home = await fetch(web.url);
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /id="external-skills-button"/u);
    assert.match(homeHtml, /skill\.state === 'disabled' \? 'enable' : skill\.state === 'imported' \? 'disable' : null/u);
    assert.match(homeHtml, /else if \(action !== null\)/u);
    assert.match(homeHtml, /actionError = error;[\s\S]+await reloadExternalSkill\(skillId\);[\s\S]+apiErrorText\(actionError\)/u);
    assert.match(homeHtml, /result\.skills\.length > 200/u);
    assert.match(homeHtml, /if \(reloadError\) \{[\s\S]+state\.externalSkills = \[\];[\s\S]+state\.externalSkillsPendingDisable = null;/u);
    assert.match(homeHtml, /async function loadExternalSkills[\s\S]+state\.externalSkills = \[\];[\s\S]+await reloadExternalSkills\(\)/u);
    const forgedHome = await requestWithHeaders(web.url, { headers: { host: 'evil.test' } });
    assert.equal(forgedHome.status, 401);
    assert.equal(forgedHome.headers['set-cookie'], undefined, 'an untrusted Host must not receive a UI session');
    assert.doesNotMatch(forgedHome.body, /id="external-skills-button"/u);
    const session = await fetch(web.url);
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const headers = { cookie: cookie as string };
    const listResponse = await fetch(`${web.url}/api/skills`, { headers });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as { skills: Array<{ skillId: string; state: string; snapshotHash: string | null; sourceWorkspace: string }>; untrusted: boolean };
    assert.equal(list.untrusted, true);
    assert.equal(list.skills.length, 1);
    assert.equal(externalSkillListItemIsValid(list.skills[0]), true);
    assert.equal(list.skills[0]?.state, 'imported');
    assert.equal(list.skills[0]?.snapshotHash, snapshot.snapshotHash);
    const workspaceResponse = await fetch(`${web.url}/api/workspaces`, { headers: { cookie: cookie as string } });
    assert.equal(workspaceResponse.status, 200);
    const workspaces = await workspaceResponse.json() as { workspaces: Array<{ workspace: string }> };
    assert.equal(workspaces.workspaces.some((item) => item.workspace === list.skills[0]!.sourceWorkspace), false);
    assert.equal((await fetch(`${web.url}/api/skills?limit=201`, { headers })).status, 400);

    const skillId = list.skills[0]!.skillId;
    const forgedHeaders = { ...headers, host: 'evil.test', origin: 'http://evil.test' };
    const forgedRead = await requestWithHeaders(`${web.url}/api/skills`, { headers: forgedHeaders });
    assert.equal(forgedRead.status, 401, 'forging Host and Origin together must not authorize reads');
    const forgedMutation = await requestWithHeaders(`${web.url}/api/skills/${encodeURIComponent(skillId)}/disable`, { method: 'POST', headers: forgedHeaders });
    assert.equal(forgedMutation.status, 401, 'forging Host and Origin together must not authorize mutations');
    const afterForgedMutation = await fetch(`${web.url}/api/skills`, { headers }).then((response) => response.json()) as { skills: Array<{ state: string }> };
    assert.equal(afterForgedMutation.skills[0]?.state, 'imported');
    const detailResponse = await fetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { skill: Record<string, unknown>; entries: Array<Record<string, unknown>>; entriesTruncated: boolean; untrusted: boolean };
    assert.equal(detail.untrusted, true);
    assert.equal(externalSkillListItemIsValid(detail.skill), true);
    assert.equal(detail.entries.length, 1);
    assert.equal(detail.entriesTruncated, false);
    assert.equal(detail.entries.every(externalSkillEntrySummaryIsValid), true);
    assert.equal('body' in detail.entries[0]!, false, 'the management API must not expose skill bodies');

    const contractFetch = globalThis.fetch.bind(globalThis);
    const contractOriginalFetch = globalThis.fetch;
    let rejectedRefreshSourceCalls = 0;
    globalThis.fetch = async () => {
      rejectedRefreshSourceCalls += 1;
      throw new Error('an invalid refresh request must not reach its source');
    };
    try {
      const assertContractDidNotMutate = async (label: string): Promise<void> => {
        const current = await contractFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json());
        assert.deepEqual(current, detail, `${label} must not mutate the skill or mappings`);
      };
      for (const query of ['unexpected=1', 'unexpected=1&unexpected=2']) {
        await assertValidationResponse(await contractFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}?${query}`, { headers }));
        await assertContractDidNotMutate(`detail query ${query}`);
      }
      for (const action of ['refresh', 'disable', 'enable'] as const) {
        for (const query of ['unexpected=1', 'unexpected=1&unexpected=2']) {
          await assertValidationResponse(await contractFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/${action}?${query}`, { method: 'POST', headers }));
          await assertContractDidNotMutate(`${action} query ${query}`);
        }
        for (const body of [' ', '{}']) {
          await assertValidationResponse(await contractFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/${action}`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body,
          }));
          await assertContractDidNotMutate(`${action} body ${JSON.stringify(body)}`);
        }
      }
      assert.equal(rejectedRefreshSourceCalls, 0);
    } finally {
      globalThis.fetch = contractOriginalFetch;
    }

    const entryId = detail.entries[0]!.entryId as string;
    const entryResponse = await fetch(`${web.url}/api/entries/${encodeURIComponent(entryId)}?workspace=${encodeURIComponent(list.skills[0]!.sourceWorkspace)}`, { headers });
    assert.equal(entryResponse.status, 200);
    const managedEntry = (await entryResponse.json() as { entry: Record<string, unknown> }).entry;
    const editResponse = await fetch(`${web.url}/api/entries/${encodeURIComponent(entryId)}?workspace=${encodeURIComponent(list.skills[0]!.sourceWorkspace)}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: managedEntry.revision, kind: managedEntry.kind, title: 'Edited managed entry', body: managedEntry.body, summary: managedEntry.summary, scope: managedEntry.scope, provenance: managedEntry.provenance, tags: managedEntry.tags }),
    });
    assert.equal(editResponse.status, 409);
    const editError = await editResponse.json() as { error: { code: string } };
    assert.equal(editError.error.code, 'CONFLICT');
    const unchangedEntry = await fetch(`${web.url}/api/entries/${encodeURIComponent(entryId)}?workspace=${encodeURIComponent(list.skills[0]!.sourceWorkspace)}`, { headers }).then((response) => response.json()) as { entry: { revision: number } };
    assert.equal(unchangedEntry.entry.revision, managedEntry.revision);

    const csrfRejected = await fetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/disable`, { method: 'POST', headers: { ...headers, origin: 'http://evil.test' } });
    assert.equal(csrfRejected.status, 401);
    const disabledResponse = await fetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/disable`, { method: 'POST', headers: { ...headers, origin: web.url } });
    assert.equal(disabledResponse.status, 200);
    const disabled = await disabledResponse.json() as { skill: { state: string } };
    assert.equal(disabled.skill.state, 'disabled');

    const httpFetch = globalThis.fetch.bind(globalThis);
    const staleOriginalFetch = globalThis.fetch;
    globalThis.fetch = async () => sourceJsonResponse({ message: 'not found' }, 404);
    try {
      const staleResponse = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/refresh`, { method: 'POST', headers });
      assert.equal(staleResponse.status, 409);
      const staleDetail = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json()) as { skill: { state: string; disabledAt: string | null }; entries: Array<{ active: boolean }> };
      assert.equal(staleDetail.skill.state, 'stale');
      assert.ok(staleDetail.skill.disabledAt);
      assert.ok(staleDetail.entries.every((entry) => entry.active === false));
    } finally {
      globalThis.fetch = staleOriginalFetch;
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/sveltejs/ai-tools') return sourceJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return sourceJsonResponse({ sha: refreshedCommit });
      if (url.pathname.includes(`/git/trees/${refreshedCommit}`)) return sourceJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: Svelte Code Writer\ndescription: safe\n---\n# Svelte\n\nRefreshed reference body.', { status: 200 });
      throw new Error(`unexpected source URL ${url}`);
    };
    try {
      const refreshedResponse = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/refresh`, { method: 'POST', headers });
      assert.equal(refreshedResponse.status, 200);
      const refreshedList = await httpFetch(`${web.url}/api/skills`, { headers }).then((response) => response.json()) as { skills: Array<{ state: string; sourceCommit: string }> };
      assert.equal(refreshedList.skills[0]?.state, 'disabled');
      assert.equal(refreshedList.skills[0]?.sourceCommit, refreshedCommit);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const disabledBlockedOriginalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/sveltejs/ai-tools') return sourceJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return sourceJsonResponse({ sha: blockedCommit });
      if (url.pathname.includes(`/git/trees/${blockedCommit}`)) return sourceJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: Svelte Code Writer\ndisable-model-invocation: true\n---\n# Svelte\n', { status: 200 });
      throw new Error(`unexpected source URL ${url}`);
    };
    try {
      const blockedWhileDisabled = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/refresh`, { method: 'POST', headers });
      assert.equal(blockedWhileDisabled.status, 422);
      const blockedDetail = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json()) as { skill: { state: string; disabledAt: string | null }; entries: Array<{ active: boolean }> };
      assert.equal(blockedDetail.skill.state, 'blocked');
      assert.ok(blockedDetail.skill.disabledAt);
      assert.ok(blockedDetail.entries.every((entry) => entry.active === false));
    } finally {
      globalThis.fetch = disabledBlockedOriginalFetch;
    }

    const disabledRecoveryOriginalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/sveltejs/ai-tools') return sourceJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return sourceJsonResponse({ sha: refreshedCommit });
      if (url.pathname.includes(`/git/trees/${refreshedCommit}`)) return sourceJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: Svelte Code Writer\ndescription: safe\n---\n# Svelte\n\nRefreshed reference body.', { status: 200 });
      throw new Error(`unexpected source URL ${url}`);
    };
    try {
      const recoveredWhileDisabled = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/refresh`, { method: 'POST', headers });
      assert.equal(recoveredWhileDisabled.status, 200);
      const recoveredDetail = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json()) as { skill: { state: string; disabledAt: string | null }; entries: Array<{ active: boolean }> };
      assert.equal(recoveredDetail.skill.state, 'disabled');
      assert.ok(recoveredDetail.skill.disabledAt);
      assert.ok(recoveredDetail.entries.every((entry) => entry.active === false));
    } finally {
      globalThis.fetch = disabledRecoveryOriginalFetch;
    }
    const enabledResponse = await fetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/enable`, { method: 'POST', headers });
    assert.equal(enabledResponse.status, 200);
    const enabled = await enabledResponse.json() as { skill: { state: string } };
    assert.equal(enabled.skill.state, 'imported');

    const validationCommit = '7'.repeat(40);
    const validationBaseline = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json());
    const validationFailures: Array<{ name: string; fetchImpl: typeof fetch }> = [
      {
        name: 'duplicate source identity',
        fetchImpl: async () => sourceRawJsonResponse('{"default_branch":"main","default_branch":"forged"}'),
      },
      {
        name: 'truncated source tree',
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname === '/repos/sveltejs/ai-tools') return sourceJsonResponse({ default_branch: 'main' });
          if (url.pathname.endsWith('/commits/main')) return sourceJsonResponse({ sha: validationCommit });
          if (url.pathname.includes(`/git/trees/${validationCommit}`)) return sourceJsonResponse({ truncated: true, tree: [] });
          throw new Error(`unexpected truncated-tree URL ${url}`);
        },
      },
      {
        name: 'oversized primary document',
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          if (url.pathname === '/repos/sveltejs/ai-tools') return sourceJsonResponse({ default_branch: 'main' });
          if (url.pathname.endsWith('/commits/main')) return sourceJsonResponse({ sha: validationCommit });
          if (url.pathname.includes(`/git/trees/${validationCommit}`)) return sourceJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }] });
          if (url.pathname.endsWith('/SKILL.md')) return new Response('x', { status: 200, headers: { 'content-length': '9999999' } });
          throw new Error(`unexpected oversized-skill URL ${url}`);
        },
      },
    ];
    for (const validationFailure of validationFailures) {
      const validationOriginalFetch = globalThis.fetch;
      globalThis.fetch = validationFailure.fetchImpl;
      try {
        const validationResponse = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/refresh`, { method: 'POST', headers });
        assert.equal(validationResponse.status, 422, validationFailure.name);
        assert.deepEqual(await validationResponse.json(), {
          error: { code: 'SECURITY_REJECTION', message: 'Request rejected', details: {} },
        }, validationFailure.name);
        const afterValidationFailure = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json());
        assert.deepEqual(afterValidationFailure, validationBaseline, `${validationFailure.name} must not mutate the stored snapshot`);
      } finally {
        globalThis.fetch = validationOriginalFetch;
      }
    }

    const programmerFailureOriginalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError('programmer-bug-sentinel'); };
    try {
      const programmerFailure = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/refresh`, { method: 'POST', headers });
      assert.equal(programmerFailure.status, 500);
      const programmerFailureBody = await programmerFailure.json() as { error: { code: string; message: string; details: Record<string, unknown> } };
      assert.deepEqual(programmerFailureBody.error, { code: 'INTEGRITY_ERROR', message: 'Unexpected server error', details: {} });
      const unchanged = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json()) as { skill: { state: string }; entries: Array<{ active: boolean }> };
      assert.equal(unchanged.skill.state, 'imported');
      assert.ok(unchanged.entries.every((entry) => entry.active));
    } finally {
      globalThis.fetch = programmerFailureOriginalFetch;
    }
    const blockedOriginalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/sveltejs/ai-tools') return sourceJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return sourceJsonResponse({ sha: blockedCommit });
      if (url.pathname.includes(`/git/trees/${blockedCommit}`)) return sourceJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/svelte-code-writer/SKILL.md' }] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: Svelte Code Writer\ndisable-model-invocation: true\n---\n# Svelte\n', { status: 200 });
      throw new Error(`unexpected source URL ${url}`);
    };
    try {
      const blockedResponse = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/refresh`, { method: 'POST', headers });
      assert.equal(blockedResponse.status, 422);
      const blockedError = await blockedResponse.json() as { error: { code: string; message: string; details: Record<string, unknown> } };
      assert.deepEqual(blockedError.error, { code: 'SECURITY_REJECTION', message: 'Request rejected', details: {} });
      const blockedList = await httpFetch(`${web.url}/api/skills`, { headers }).then((response) => response.json()) as { skills: Array<{ state: string }> };
      assert.equal(blockedList.skills[0]?.state, 'blocked');
      const blockedDetail = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json()) as { entries: Array<{ active: boolean }> };
      assert.ok(blockedDetail.entries.every((entry) => entry.active === false));
      const blockedDisable = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/disable`, { method: 'POST', headers });
      assert.equal(blockedDisable.status, 409);
      const blockedDisableBody = await blockedDisable.json() as { error: { code: string } };
      assert.equal(blockedDisableBody.error.code, 'CONFLICT');
      const afterRejectedDisable = await httpFetch(`${web.url}/api/skills`, { headers }).then((response) => response.json()) as { skills: Array<{ state: string }> };
      assert.equal(afterRejectedDisable.skills[0]?.state, 'blocked');
    } finally {
      globalThis.fetch = blockedOriginalFetch;
    }
    const missingOriginalFetch = globalThis.fetch;
    globalThis.fetch = async () => sourceJsonResponse({ message: 'not found' }, 404);
    try {
      const missingResponse = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}/refresh`, { method: 'POST', headers });
      assert.equal(missingResponse.status, 409);
      const missingError = await missingResponse.json() as { error: { code: string; message: string; details: Record<string, unknown> } };
      assert.deepEqual(missingError.error, { code: 'CONFLICT', message: 'Request conflicts with current state', details: {} });
      const stillBlocked = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(skillId)}`, { headers }).then((response) => response.json()) as { skill: { state: string }; entries: Array<{ active: boolean }> };
      assert.equal(stillBlocked.skill.state, 'blocked');
      assert.ok(stillBlocked.entries.every((entry) => entry.active === false));
    } finally {
      globalThis.fetch = missingOriginalFetch;
    }
  } finally {
    await web.close();
  }
});

test('External Skills web refresh rejects an unverified stale row without persisted applicability', async () => {
  const recoveredCommit = '8'.repeat(40);
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-web-unmaterialized-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = await openCurrentDatabase(databasePath);
  const candidate: SkillCandidate = {
    id: 'fixture:owner/web-recovery:web-recovery', provider: 'fixture', name: 'web-recovery', slug: 'web-recovery', source: 'owner/web-recovery', sourceType: 'github', installUrl: 'https://github.com/owner/web-recovery', installs: 0, duplicate: false, officialStatus: 'unknown',
  };
  const discovered = recordDiscoveredSkill(database, candidate, '2026-08-25T00:00:00.000Z');
  markExternalSkillRefreshFailure(database, discovered.skillId, 'stale', { generation: discovered.generation, sourceCommit: discovered.sourceCommit, snapshotHash: discovered.snapshotHash, state: discovered.state, lastCheckedAt: discovered.lastCheckedAt }, '2026-08-25T01:00:00.000Z');
  database.close();

  const web = await startWebServer({ databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(directory, 'runtime') } });
  const originalFetch = globalThis.fetch;
  try {
    const session = await originalFetch(web.url);
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const headers = { cookie: cookie as string };
    const httpFetch = originalFetch.bind(globalThis);
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/repos/owner/web-recovery') return sourceJsonResponse({ default_branch: 'main' });
      if (url.pathname.endsWith('/commits/main')) return sourceJsonResponse({ sha: recoveredCommit });
      if (url.pathname.includes(`/git/trees/${recoveredCommit}`)) return sourceJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/web-recovery/SKILL.md' }] });
      if (url.pathname.endsWith('/SKILL.md')) return new Response('---\nname: Web recovery\ndescription: safe\n---\n# Web recovery\n\nRecovered.', { status: 200 });
      throw new Error(`unexpected web recovery source URL ${url}`);
    };

    const response = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(discovered.skillId)}/refresh`, { method: 'POST', headers });
    assert.equal(response.status, 422);
    const result = await response.json() as { error: { code: string } };
    assert.equal(result.error.code, 'SECURITY_REJECTION');
    const detailResponse = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(discovered.skillId)}`, { headers });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { skill: { state: string; sourceCommit: string | null; snapshotHash: string | null }; entries: Array<{ active: boolean }> };
    assert.equal(detail.skill.state, 'stale');
    assert.equal(detail.skill.sourceCommit, null);
    assert.equal(detail.skill.snapshotHash, null);
    assert.equal(detail.entries.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await web.close();
  }
});

test('External Skills web refresh caches an exact audit failure and does not reuse a stored passed audit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-web-fresh-audit-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = await openCurrentDatabase(databasePath);
  const candidate: SkillCandidate = {
    id: 'skills-sh-v1:community/web-refresh:react-helper', provider: 'skills-sh-v1', name: 'react-helper', slug: 'react-helper', source: 'community/web-refresh', sourceType: 'github', installUrl: 'https://github.com/community/web-refresh', installs: 0, duplicate: false, officialStatus: 'registry-only', auditStatus: 'passed',
  };
  const snapshot = validateSkillSnapshot({ candidate, sourceCommit: '9'.repeat(40), files: [{ path: 'skills/react-helper/SKILL.md', content: '---\nname: react-helper\ndescription: safe\n---\n# React\n', primary: true }] });
  const fixtureProvider: SkillRegistryProvider = {
    id: candidate.provider,
    async search() { return { provider: candidate.provider, experimental: false, candidates: [] }; },
    async audit() { return { status: 'passed' }; },
  };
  const authorization = await authorizeSkillMaterialization(fixtureProvider, candidate);
  assert.equal(authorization.status, 'passed');
  if (authorization.status !== 'passed') throw new Error('fixture audit did not issue materialization authority');
  const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
    skillName: snapshot.frontmatter.name, sourcePath: snapshot.files[0]!.path, markdown: snapshot.files[0]!.content,
    summary: snapshot.frontmatter.description, stripFrontmatter: true,
  }), {
    id: 'react', technology: 'react', aliases: ['react'], queries: ['react'], owners: ['community'], repositories: ['community/web-refresh'],
    applicability: { frameworks: [{ name: 'React' }] }, signals: { packages: ['react'] }, reason: 'fixture',
  }, undefined, authorization.authorization);
  database.close();

  const originalV1Token = process.env.KIOKUKO_SKILLS_V1_TOKEN;
  process.env.KIOKUKO_SKILLS_V1_TOKEN = 'web-audit-cache-fixture';
  const web = await startWebServer({ databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(directory, 'runtime') } });
  const originalFetch = globalThis.fetch;
  let auditCalls = 0;
  try {
    const session = await originalFetch(web.url);
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const headers = { cookie: cookie as string };
    const httpFetch = originalFetch.bind(globalThis);
    const baseline = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}`, { headers }).then((value) => value.json());
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.match(url.pathname, /^\/api\/v1\/skills\/audit\//u);
      auditCalls += 1;
      return sourceJsonResponse({ message: 'unavailable' }, 503);
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, { method: 'POST', headers });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable', details: {} },
      });
      const unchanged = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}`, { headers }).then((value) => value.json());
      assert.deepEqual(unchanged, baseline, 'audit failure and its cached replay must not mutate the snapshot or mappings');
    }
    assert.equal(auditCalls, 1, 'the persistent audit backoff must suppress the repeated upstream audit');

    const inspection = openConnection(databasePath);
    try {
      const rows = inspection.prepare('SELECT cache_key, provider, source_type, source_locator, slug, outcome, fetched_at, expires_at FROM skill_audit_failure_cache').all<{
        cache_key: string; provider: string; source_type: string; source_locator: string; slug: string; outcome: string; fetched_at: string; expires_at: string;
      }>();
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.deepEqual({
        cacheKey: row.cache_key,
        provider: row.provider,
        sourceType: row.source_type,
        sourceLocator: row.source_locator,
        slug: row.slug,
        outcome: row.outcome,
      }, {
        cacheKey: canonicalContentHash({ provider: candidate.provider, sourceType: candidate.sourceType, sourceLocator: candidate.source, slug: candidate.slug }),
        provider: candidate.provider,
        sourceType: candidate.sourceType,
        sourceLocator: candidate.source,
        slug: candidate.slug,
        outcome: 'registry_unavailable',
      });
      assert.equal(Date.parse(row.expires_at) - Date.parse(row.fetched_at), DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS);
      assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 0);
    } finally {
      inspection.close();
    }
  } finally {
    globalThis.fetch = originalFetch;
    await web.close();
    if (originalV1Token === undefined) delete process.env.KIOKUKO_SKILLS_V1_TOKEN;
    else process.env.KIOKUKO_SKILLS_V1_TOKEN = originalV1Token;
  }
});

test('External Skills web keeps network waits outside the write queue and caches one exact source failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-web-source-backoff-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = await openCurrentDatabase(databasePath);
  const candidate: SkillCandidate = {
    id: 'fixture:sveltejs/ai-tools:svelte-code-writer', provider: 'fixture', name: 'Svelte Code Writer', slug: 'svelte-code-writer', source: 'sveltejs/ai-tools', sourceType: 'github', installUrl: 'https://github.com/sveltejs/ai-tools', installs: 0, duplicate: false, officialStatus: 'catalog-verified',
  };
  const snapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: '6'.repeat(40),
    files: [{ path: 'skills/svelte-code-writer/SKILL.md', content: '---\nname: Svelte Code Writer\ndescription: safe\n---\n# Svelte\n', primary: true }],
  });
  const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
    skillName: snapshot.frontmatter.name,
    sourcePath: snapshot.files[0]!.path,
    markdown: snapshot.files[0]!.content,
    summary: snapshot.frontmatter.description,
    stripFrontmatter: true,
  }), requirementForOfficialSkill(candidate));
  database.close();

  const web = await startWebServer({
    databasePath,
    host: '127.0.0.1',
    port: 0,
    httpOptions: { runtimeDirectory: path.join(directory, 'runtime'), queueCapacity: 1 },
  });
  const originalFetch = globalThis.fetch;
  const sourceStarted = deferred<void>();
  const releaseSource = deferred<void>();
  let sourceCalls = 0;
  let released = false;
  try {
    const session = await originalFetch(web.url);
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const headers = { cookie: cookie as string };
    const httpFetch = originalFetch.bind(globalThis);
    const baseline = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}`, { headers }).then((value) => value.json());
    globalThis.fetch = async () => {
      sourceCalls += 1;
      sourceStarted.resolve();
      await releaseSource.promise;
      return sourceJsonResponse({ message: 'unavailable' }, 503);
    };

    const firstRefresh = httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, { method: 'POST', headers });
    await within(sourceStarted.promise, 2_000, 'source request');
    const concurrentMutation = await within(
      httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/enable`, { method: 'POST', headers }),
      2_000,
      'concurrent queued mutation',
    );
    assert.equal(concurrentMutation.status, 409, 'the network wait must not occupy the one-slot write queue');

    released = true;
    releaseSource.resolve();
    for (const response of [await firstRefresh, await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, { method: 'POST', headers })]) {
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable', details: {} },
      });
      const unchanged = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}`, { headers }).then((value) => value.json());
      assert.deepEqual(unchanged, baseline, 'source failure and its cached replay must not mutate the snapshot or mappings');
    }
    assert.equal(sourceCalls, 1, 'the persistent source backoff must suppress the repeated upstream fetch');

    const inspection = openConnection(databasePath);
    try {
      const rows = inspection.prepare('SELECT cache_key, source_type, source_locator, slug, outcome, fetched_at, expires_at FROM skill_source_failure_cache').all<{
        cache_key: string; source_type: string; source_locator: string; slug: string; outcome: string; fetched_at: string; expires_at: string;
      }>();
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.deepEqual({
        cacheKey: row.cache_key,
        sourceType: row.source_type,
        sourceLocator: row.source_locator,
        slug: row.slug,
        outcome: row.outcome,
      }, {
        cacheKey: canonicalContentHash({ sourceType: candidate.sourceType, sourceLocator: candidate.source, slug: candidate.slug }),
        sourceType: candidate.sourceType,
        sourceLocator: candidate.source,
        slug: candidate.slug,
        outcome: 'source_unavailable',
      });
      assert.equal(Date.parse(row.expires_at) - Date.parse(row.fetched_at), DEFAULT_EXTERNAL_SKILL_FAILURE_TTL_MS);
      assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 0);
    } finally {
      inspection.close();
    }
  } finally {
    if (!released) releaseSource.resolve();
    globalThis.fetch = originalFetch;
    await web.close();
  }
});

test('External Skills web single-flights one exact audited refresh and cleans failed flights', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-web-single-flight-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = await openCurrentDatabase(databasePath);
  const candidate: SkillCandidate = {
    id: 'skills-sh-v1:community/single-flight:react-helper', provider: 'skills-sh-v1', name: 'react-helper', slug: 'react-helper', source: 'community/single-flight', sourceType: 'github', installUrl: 'https://github.com/community/single-flight', installs: 0, duplicate: false, officialStatus: 'registry-only',
  };
  const initialSnapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: '4'.repeat(40),
    files: [{ path: 'skills/react-helper/SKILL.md', content: '---\nname: react-helper\ndescription: initial\n---\n# React\n\nInitial.', primary: true }],
  });
  const fixtureProvider: SkillRegistryProvider = {
    id: candidate.provider,
    async search() { return { provider: candidate.provider, experimental: false, candidates: [] }; },
    async audit() { return { status: 'passed' }; },
  };
  const initialAuthorization = await authorizeSkillMaterialization(fixtureProvider, candidate);
  assert.equal(initialAuthorization.status, 'passed');
  if (initialAuthorization.status !== 'passed') throw new Error('fixture audit did not issue materialization authority');
  const requirement = {
    id: 'react', technology: 'react', aliases: ['react'], queries: ['react'], owners: ['community'], repositories: ['community/single-flight'],
    applicability: { frameworks: [{ name: 'React' }] }, signals: { packages: ['react'] }, reason: 'single-flight fixture',
  };
  const imported = importSkillSnapshot(database, initialSnapshot, chunkSkillMarkdown({
    skillName: initialSnapshot.frontmatter.name,
    sourcePath: initialSnapshot.files[0]!.path,
    markdown: initialSnapshot.files[0]!.content,
    summary: initialSnapshot.frontmatter.description,
    stripFrontmatter: true,
  }), requirement, undefined, initialAuthorization.authorization);
  const initialGeneration = database.prepare('SELECT generation FROM external_skills WHERE skill_id = ?').get<{ generation: number }>(imported.skillId)!.generation;
  database.close();

  const originalV1Token = process.env.KIOKUKO_SKILLS_V1_TOKEN;
  process.env.KIOKUKO_SKILLS_V1_TOKEN = 'web-single-flight-fixture';
  const web = await startWebServer({ databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(directory, 'runtime') } });
  const originalFetch = globalThis.fetch;
  const releasePendingOperations: Array<() => void> = [];
  const refreshCommit = '5'.repeat(40);
  const auditBody = JSON.stringify({
    id: `${candidate.source}/${candidate.slug}`,
    source: candidate.source,
    slug: candidate.slug,
    audits: [{ provider: 'Fixture', slug: 'fixture', status: 'pass', riskLevel: 'LOW', summary: 'Safe fixture.', auditedAt: '2026-08-25T00:00:00.000Z' }],
  });
  try {
    const session = await originalFetch(web.url);
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const headers = { cookie: cookie as string };
    const httpFetch = originalFetch.bind(globalThis);
    const firstAuditStarted = deferred<void>();
    const releaseFirstAudit = deferred<void>();
    releasePendingOperations.push(() => releaseFirstAudit.resolve());
    let auditCalls = 0;
    const githubCalls = { repository: 0, commit: 0, tree: 0, primary: 0 };
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'skills.sh') {
        auditCalls += 1;
        firstAuditStarted.resolve();
        await releaseFirstAudit.promise;
        return new Response(auditBody, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/repos/community/single-flight') {
        githubCalls.repository += 1;
        return sourceJsonResponse({ default_branch: 'main' });
      }
      if (url.pathname.endsWith('/commits/main')) {
        githubCalls.commit += 1;
        return sourceJsonResponse({ sha: refreshCommit });
      }
      if (url.pathname.includes(`/git/trees/${refreshCommit}`)) {
        githubCalls.tree += 1;
        return sourceJsonResponse({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'skills/react-helper/SKILL.md' }] });
      }
      if (url.pathname.endsWith('/SKILL.md')) {
        githubCalls.primary += 1;
        return new Response('---\nname: react-helper\ndescription: refreshed\n---\n# React\n\nRefreshed once.', { status: 200 });
      }
      throw new Error(`unexpected single-flight URL ${url}`);
    };

    let observedRefreshes = 0;
    const secondRefreshEnded = deferred<void>();
    const observeSuccessPair = (request: import('node:http').IncomingMessage): void => {
      if (!new URL(request.url ?? '/', web.url).pathname.endsWith('/refresh')) return;
      observedRefreshes += 1;
      if (observedRefreshes === 2) request.once('end', () => secondRefreshEnded.resolve());
    };
    web.server.on('request', observeSuccessPair);
    const first = httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, { method: 'POST', headers });
    await within(firstAuditStarted.promise, 2_000, 'first provider audit');
    const second = httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, { method: 'POST', headers });
    await within(secondRefreshEnded.promise, 2_000, 'second coalesced request');
    releaseFirstAudit.resolve();
    const responses = await Promise.all([first, second]);
    web.server.off('request', observeSuccessPair);
    const responseBodies = [];
    for (const response of responses) {
      const body = await response.text();
      assert.equal(response.status, 200, body);
      responseBodies.push(JSON.parse(body) as unknown);
    }
    assert.deepEqual(responseBodies[1], responseBodies[0], 'coalesced callers must receive the same committed result');
    assert.equal(auditCalls, 1);
    assert.deepEqual(githubCalls, { repository: 1, commit: 1, tree: 1, primary: 1 });

    const afterSuccess = openConnection(databasePath);
    try {
      const row = afterSuccess.prepare('SELECT generation, source_commit AS sourceCommit FROM external_skills WHERE skill_id = ?').get<{ generation: number; sourceCommit: string }>(imported.skillId)!;
      assert.deepEqual({ ...row }, { generation: initialGeneration + 2, sourceCommit: refreshCommit }, 'the shared flight must commit exactly one refresh transaction');
      assert.equal(afterSuccess.prepare('SELECT COUNT(*) AS count FROM entry_revisions WHERE entry_id IN (SELECT entry_id FROM external_skill_entries WHERE skill_id = ?)').get<{ count: number }>(imported.skillId)?.count, 2);
      assert.equal(afterSuccess.prepare('SELECT COUNT(*) AS count FROM skill_audit_failure_cache').get<{ count: number }>()?.count, 0);
      assert.equal(afterSuccess.prepare('SELECT COUNT(*) AS count FROM skill_source_failure_cache').get<{ count: number }>()?.count, 0);
    } finally {
      afterSuccess.close();
    }

    const failureBaseline = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}`, { headers }).then((value) => value.json());
    const failedAuditStarted = deferred<void>();
    const releaseFailedAudit = deferred<void>();
    releasePendingOperations.push(() => releaseFailedAudit.resolve());
    let failedAuditCalls = 0;
    let invalidSourceCalls = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'skills.sh') {
        failedAuditCalls += 1;
        if (failedAuditCalls === 1) {
          failedAuditStarted.resolve();
          await releaseFailedAudit.promise;
        }
        return new Response(auditBody, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      invalidSourceCalls += 1;
      return sourceRawJsonResponse('{"default_branch":"main","default_branch":"forged"}');
    };
    observedRefreshes = 0;
    const secondFailureEnded = deferred<void>();
    const observeFailurePair = (request: import('node:http').IncomingMessage): void => {
      if (!new URL(request.url ?? '/', web.url).pathname.endsWith('/refresh')) return;
      observedRefreshes += 1;
      if (observedRefreshes === 2) request.once('end', () => secondFailureEnded.resolve());
    };
    web.server.on('request', observeFailurePair);
    const failedFirst = httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, { method: 'POST', headers });
    await within(failedAuditStarted.promise, 2_000, 'failed provider audit');
    const failedSecond = httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, { method: 'POST', headers });
    await within(secondFailureEnded.promise, 2_000, 'second failed coalesced request');
    releaseFailedAudit.resolve();
    const failedResponses = await Promise.all([failedFirst, failedSecond]);
    web.server.off('request', observeFailurePair);
    const failedBodies = [];
    for (const response of failedResponses) {
      assert.equal(response.status, 422);
      failedBodies.push(await response.json());
    }
    assert.deepEqual(failedBodies[1], failedBodies[0]);
    assert.equal(failedAuditCalls, 1);
    assert.equal(invalidSourceCalls, 1);
    assert.deepEqual(await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}`, { headers }).then((value) => value.json()), failureBaseline);

    const retriedFailure = await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, { method: 'POST', headers });
    assert.equal(retriedFailure.status, 422);
    assert.equal(failedAuditCalls, 2, 'a failed flight must be removed before an exact-revision retry');
    assert.equal(invalidSourceCalls, 2);
    assert.deepEqual(await httpFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}`, { headers }).then((value) => value.json()), failureBaseline);
  } finally {
    releasePendingOperations.forEach((release) => release());
    globalThis.fetch = originalFetch;
    await web.close();
    if (originalV1Token === undefined) delete process.env.KIOKUKO_SKILLS_V1_TOKEN;
    else process.env.KIOKUKO_SKILLS_V1_TOKEN = originalV1Token;
  }
});

test('External Skills web list paginates with an opaque snapshot-bound cursor', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-external-skill-web-pagination-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = await openCurrentDatabase(databasePath);
  const first = recordDiscoveredSkill(database, {
    id: 'fixture:alpha/repo:alpha', provider: 'fixture', name: 'alpha', slug: 'alpha', source: 'alpha/repo', sourceType: 'github', installUrl: 'https://github.com/alpha/repo', installs: 0, duplicate: false, officialStatus: 'unknown',
  }, '2026-08-25T00:00:00.000Z');
  const second = recordDiscoveredSkill(database, {
    id: 'fixture:beta/repo:beta', provider: 'fixture', name: 'beta', slug: 'beta', source: 'beta/repo', sourceType: 'github', installUrl: 'https://github.com/beta/repo', installs: 0, duplicate: false, officialStatus: 'unknown',
  }, '2026-08-25T00:00:01.000Z');
  database.close();

  const web = await startWebServer({ databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(directory, 'runtime') } });
  try {
    const session = await fetch(web.url);
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const headers = { cookie: cookie as string };

    const firstResponse = await fetch(`${web.url}/api/skills?limit=1`, { headers });
    assert.equal(firstResponse.status, 200);
    const firstPage = await firstResponse.json() as { skills: Array<{ skillId: string }>; count: number; truncated: boolean; nextCursor: string | null };
    assert.equal(firstPage.count, 1);
    assert.equal(firstPage.skills[0]?.skillId, first.skillId);
    assert.equal(firstPage.truncated, true);
    assert.equal(typeof firstPage.nextCursor, 'string');
    assert.deepEqual(Object.keys(firstPage.skills[0] ?? {}).includes('metadata'), true);
    assert.deepEqual(Object.keys((firstPage.skills[0] as { metadata?: Record<string, unknown> }).metadata ?? {}).sort(), ['documents', 'technology']);

    const secondResponse = await fetch(`${web.url}/api/skills?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, { headers });
    assert.equal(secondResponse.status, 200);
    const secondPage = await secondResponse.json() as { skills: Array<{ skillId: string }>; count: number; truncated: boolean; nextCursor: string | null };
    assert.equal(secondPage.count, 1);
    assert.notEqual(secondPage.skills[0]?.skillId, first.skillId);
    assert.equal(secondPage.truncated, false);
    assert.equal(secondPage.nextCursor, null);

    assert.equal((await fetch(`${web.url}/api/skills?cursor=not_base64!`, { headers })).status, 400);
    assert.equal((await fetch(`${web.url}/api/skills?cursor=${encodeURIComponent(Buffer.from([0xff]).toString('base64url'))}`, { headers })).status, 400);
    assert.equal((await fetch(`${web.url}/api/skills?cursor=${encodeURIComponent(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[1,0,null,"a","b","c","d"]')]).toString('base64url'))}`, { headers })).status, 400);
    assert.equal((await fetch(`${web.url}/api/skills?cursor=${encodeURIComponent(Buffer.from('[1,0,["discovered"],"a","b","c","d"]').toString('base64url'))}`, { headers })).status, 400);
    assert.equal((await fetch(`${web.url}/api/skills?unknown=true`, { headers })).status, 400);
    assert.equal((await fetch(`${web.url}/api/skills?limit=1&limit=2`, { headers })).status, 400);
    assert.equal((await fetch(`${web.url}/api/skills?limit=1&state=discovered&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, { headers })).status, 409);

    const writer = openConnection(databasePath);
    try {
      markExternalSkillRefreshFailure(writer, second.skillId, 'stale', {
        generation: second.generation,
        sourceCommit: second.sourceCommit,
        snapshotHash: second.snapshotHash,
        state: second.state,
        lastCheckedAt: second.lastCheckedAt,
      }, '2026-08-25T00:00:02.000Z');
    } finally {
      writer.close();
    }
    const changedCursor = await fetch(`${web.url}/api/skills?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, { headers });
    assert.equal(changedCursor.status, 409);
  } finally {
    await web.close();
  }
});
