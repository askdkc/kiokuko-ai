import { spawn } from 'node:child_process';

export class SourceFailure extends Error {
  constructor(readonly reason: string) { super(reason); }
}
export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  stdoutLimit?: number;
  stderrLimit?: number;
  env?: NodeJS.ProcessEnv;
}
export interface ProcessOutput { stdout: Buffer; stderr: Buffer; code: number | null }
export type SourceRunner = (request: ProcessRequest) => Promise<ProcessOutput>;

/** Own the process group until its pipes close; never expose raw diagnostics in errors. */
export const runSourceProcess: SourceRunner = async request => {
  request.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env: request.env ?? {
        PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
      },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outBytes = 0, errBytes = 0;
    let failure: unknown;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new SourceFailure('cleanup_failed');
      }
    };
    const abort = () => { failure ??= request.signal.reason; kill(); };
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    child.stdout.on('data', (bytes: Buffer) => {
      outBytes += bytes.length;
      if (outBytes > (request.stdoutLimit ?? 256 * 1024)) { failure ??= new SourceFailure('output_limit'); kill(); }
      else stdout.push(bytes);
    });
    child.stderr.on('data', (bytes: Buffer) => {
      errBytes += bytes.length;
      if (errBytes > (request.stderrLimit ?? 16 * 1024)) { failure ??= new SourceFailure('output_limit'); kill(); }
      else stderr.push(bytes);
    });
    child.on('error', () => { failure ??= new SourceFailure('spawn_failed'); });
    child.on('exit', kill); // also reap descendants that inherited our pipes
    child.on('close', code => {
      request.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
    });
  });
};
