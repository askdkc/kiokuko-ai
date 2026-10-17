import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';

export interface LispResult { status: 'ok' | 'error' | 'output_limit'; output: string }
/** One persistent SBCL actor. Abort owns the whole process group through a liveness supervisor. */
export class LispWorker {
  private child: ChildProcess | undefined;
  private wire: Duplex | undefined;
  private scratch: string | undefined;
  private exit: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private pending: { resolve(value: LispResult): void; reject(error: Error): void; id: number } | undefined;
  private buffer = '';
  private sequence = 0;
  private busy = false;
  private closed = false;
  constructor(private readonly cwd: string, private readonly binary = 'sbcl', private readonly nodeExecutable = process.execPath,
    private readonly library = fileURLToPath(new URL('../../lisp/', import.meta.url))) {}
  async evaluate(code: string, timeoutMs: number, signal: AbortSignal): Promise<LispResult> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('lisp_worker_closed');
    if (this.busy) throw new Error('lisp_worker_busy');
    this.busy = true;
    const controller = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const abort = () => { this.pending?.reject(new Error(controller.reason?.name === 'TimeoutError' ? 'lisp_timeout_state_reset' : 'lisp_cancelled_state_reset')); void this.stop(); };
    controller.addEventListener('abort', abort, { once: true });
    try {
      if (!this.child) await this.start(controller);
      controller.throwIfAborted();
      const id = ++this.sequence;
      const result = new Promise<LispResult>((resolve, reject) => { this.pending = { id, resolve, reject }; });
      this.wire!.write(`${id} ${Buffer.from(code).toString('hex')}\n`);
      const value = await result;
      if (value.status === 'output_limit') await this.stop();
      return value;
    } catch (error) { await this.stop(); throw error; }
    finally { this.pending = undefined; this.busy = false; controller.removeEventListener('abort', abort); }
  }
  private async start(signal: AbortSignal): Promise<void> {
    this.scratch = await mkdtemp(path.join(tmpdir(), 'kiokuko-lisp-'));
    if (this.closed || signal.aborted) { await rm(this.scratch, { recursive: true, force: true }); throw new Error('lisp_cancelled_state_reset'); }
    this.child = spawn(this.nodeExecutable, [path.join(this.library, 'supervisor.mjs'), this.binary, this.cwd, path.join(this.library, 'runtime.lisp')], {
      shell: false, cwd: this.cwd, env: { PATH: process.env.PATH, HOME: this.scratch, TMPDIR: this.scratch, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    this.wire = this.child.stdio[3] as Duplex;
    let ready: (() => void) | undefined, fail: ((error: Error) => void) | undefined, rawBytes = 0;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    const broken = (reason = 'lisp_runtime_unavailable_or_exited') => { const error = new Error(reason); fail?.(error); this.pending?.reject(error); };
    this.exit = new Promise(resolve => { this.child!.once('close', () => { broken(); resolve(); }); });
    this.child.once('error', () => broken());
    for (const stream of [this.child.stdout, this.child.stderr]) stream!.on('data', (chunk: Buffer) => {
      rawBytes += chunk.length;
      if (rawBytes > 8192) { broken('lisp_output_limit_state_reset'); void this.stop(); }
    });
    this.wire.on('error', () => broken());
    this.wire.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 128 * 1024) { broken('lisp_output_limit_state_reset'); void this.stop(); return; }
      for (let newline; (newline = this.buffer.indexOf('\n')) >= 0;) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (line === 'ready' && ready) { ready(); ready = undefined; fail = undefined; continue; }
        const match = /^(\d+) (ok|error|output_limit) ([A-F0-9]*)$/u.exec(line);
        if (!match || !this.pending || Number(match[1]) !== this.pending.id || match[3]!.length % 2) { broken(); void this.stop(); return; }
        const output = Buffer.from(match[3]!, 'hex').toString('utf8');
        if (Buffer.byteLength(output) > 32 * 1024) { broken('lisp_output_limit_state_reset'); void this.stop(); return; }
        this.pending.resolve({ status: match[2] as LispResult['status'], output });
      }
    });
    const cancelled = () => fail?.(new Error('lisp_start_cancelled'));
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
    try { await started; } finally { signal.removeEventListener('abort', cancelled); }
  }
  get stopped(): boolean { return this.closed; }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.stopPromise = (async () => {
      this.child?.stdin?.end(); this.child?.kill('SIGTERM');
      await this.exit;
      if (this.scratch) await rm(this.scratch, { recursive: true, force: true });
    })();
    return this.stopPromise;
  }
}
