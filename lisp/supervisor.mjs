// Adapted from kiokuko-dsh/lisp/supervisor.mjs (MIT). Parent liveness stays
// outside evaluated Lisp. SBCL run-program can create separate process groups;
// freeze and traverse the OS-owned descendant tree before terminating it.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const [binary, cwd, runtime] = process.argv.slice(2);
const processTable = async () => {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 2000 });
  return stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
};
let child, stopping, requested = false;
const signal = (pid, value) => { try { process.kill(pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
const stop = () => {
  requested = true;
  return stopping ??= (async () => {
    if (!child?.pid) return;
    const owned = new Set([child.pid]);
    signal(child.pid, 'SIGSTOP');
    try {
      // Each discovered parent is frozen before the next traversal, so ordinary
      // children cannot keep extending their subtree while it is collected.
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, parent] of await processTable()) if (owned.has(parent) && !owned.has(pid)) {
          signal(pid, 'SIGSTOP'); owned.add(pid); changed = true;
        }
      }
    } finally {
      for (const pid of [...owned].reverse()) signal(pid, 'SIGKILL');
      signal(-child.pid, 'SIGKILL');
    }
  })();
};
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
process.stdin.on('end', () => { void stop(); }); process.stdin.on('error', () => { void stop(); }); process.stdin.resume();
// Fail before Lisp dispatch when descendant supervision is unavailable.
await processTable();
if (!requested) {
  child = spawn(binary, ['--noinform', '--dynamic-space-size', '128', '--disable-debugger', '--no-sysinit', '--no-userinit', '--script', runtime],
    { cwd, env: process.env, detached: true, stdio: ['ignore', 'inherit', 'inherit', 3] });
  child.once('error', () => process.exit(70));
  child.once('exit', code => { void stop().finally(() => process.exit(code ?? 70)); });
}
