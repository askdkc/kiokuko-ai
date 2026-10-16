import { runHostContract } from './run-opencode-host-e2e.mjs';
try { await runHostContract({ lisp: true }); }
catch (error) { console.error(JSON.stringify({ status: 'failed', reason: error instanceof Error ? error.message : 'lisp_host_failed' })); process.exitCode = 1; }
