import { runHostContract } from './run-opencode-host-e2e.mjs';

try {
  await runHostContract({ execution: true });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ protocolVersion: 2, status: 'failed', reason: error instanceof Error ? error.message : 'execution_contract_failed' })}\n`);
  process.exitCode = 1;
}
