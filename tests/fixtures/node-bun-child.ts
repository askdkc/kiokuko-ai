import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

/** Adapt Node stream errors to the awaited Bun pipe contract used by plugin hooks. */
export function spawnNodeBunChild(argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(argv[0]!, argv.slice(1), { ...options, stdio: 'pipe' });
  const writer = Writable.toWeb(child.stdin).getWriter();
  return {
    stdin: { write: (text: string) => writer.write(text), end: () => writer.close() },
    stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr),
    exited: new Promise<number>(resolve => {
      child.once('error', () => undefined);
      child.once('close', code => resolve(code ?? 1));
    }),
    kill: () => { child.kill(); },
  };
}
