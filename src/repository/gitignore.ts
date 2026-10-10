import path from 'node:path';
import { assertAtomicCleanupComplete, assertFileExpectation, atomicWriteTextIfUnchanged, readRegularFile } from '../agent-file/atomic-write.js';
import { KiokukoError } from '../errors.js';

export const PROJECT_BINDING_IGNORE_ENTRY = '.kiokuko.json';
export const AGENTICREPLAY_IGNORE_ENTRY = '.agenticreplay/';

export interface RenderedProjectGitignore {
  content: string;
  action: 'created' | 'updated' | 'unchanged';
}

function containsProjectBindingEntry(content: string): boolean {
  return content
    .replaceAll('\r\n', '\n')
    .split('\n')
    .some((line) => line === PROJECT_BINDING_IGNORE_ENTRY || line === `/${PROJECT_BINDING_IGNORE_ENTRY}`);
}

/** Append the project binding ignore entry without rewriting user-owned bytes. */
export function renderProjectGitignore(existing: string | undefined): RenderedProjectGitignore {
  if (existing !== undefined && containsProjectBindingEntry(existing)) {
    return { content: existing, action: 'unchanged' };
  }
  const current = existing ?? '';
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current.length === 0 || current.endsWith('\n') ? '' : newline;
  return {
    content: `${current}${separator}${PROJECT_BINDING_IGNORE_ENTRY}${newline}`,
    action: existing === undefined ? 'created' : 'updated',
  };
}

/** A later negation can reopen captures; append protection after it. */
export function renderAgenticReplayGitignore(existing: string | undefined): RenderedProjectGitignore {
  const current = existing ?? '';
  const lines = current.replaceAll('\r\n', '\n').split('\n');
  let protectedEntry = false;
  for (const line of lines) {
    // Root-only rules do not protect stores recorded from subdirectories.
    if (line === '.agenticreplay' || line === AGENTICREPLAY_IGNORE_ENTRY) protectedEntry = true;
    else if (line.startsWith('!')) protectedEntry = false;
  }
  if (existing !== undefined && protectedEntry) {
    return { content: current, action: 'unchanged' };
  }
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current.length === 0 || current.endsWith('\n') ? '' : newline;
  return { content: `${current}${separator}${AGENTICREPLAY_IGNORE_ENTRY}${newline}`, action: existing === undefined ? 'created' : 'updated' };
}

/** Protect both root captures and a nested capture CWD's overriding ignore rules. */
export async function ensureAgenticReplayIgnored(repositoryRoot: string, captureCwd = repositoryRoot): Promise<void> {
  for (const directory of new Set([repositoryRoot, captureCwd])) {
    const file = path.join(directory, '.gitignore');
    for (let attempt = 0; ; attempt++) {
      try {
        const expected = await readRegularFile(file, { containmentRoot: repositoryRoot, maxBytes: 1024 * 1024 });
        const rendered = renderAgenticReplayGitignore(expected?.content);
        const expectation = { expected, containmentRoot: repositoryRoot, maxBytes: 1024 * 1024 };
        if (rendered.action === 'unchanged') await assertFileExpectation(file, expectation);
        else assertAtomicCleanupComplete(await atomicWriteTextIfUnchanged(file, rendered.content, expectation, expected?.mode ?? 0o644));
        break;
      } catch (error) {
        // Re-read after another recorder changes the file; never overwrite a stale snapshot.
        if (!(error instanceof KiokukoError) || error.code !== 'CONFLICT' || attempt >= 2) throw error;
      }
    }
  }
}
