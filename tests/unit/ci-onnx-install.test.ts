import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

type Environment = Record<string, string>;
type Step = { name?: string; run?: string; env?: Environment };
type Workflow = { env?: Environment; jobs: Record<string, { env?: Environment; steps: Step[] }> };

test('CPU CI inherits the ONNX extra-download opt-out through every dependency install', () => {
  const workflow = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as Workflow;
  // Workflow scope also covers nested npm commands and fixture installs launched by verification.
  assert.equal(workflow.env?.ONNXRUNTIME_NODE_INSTALL, 'skip');
  const installJobs = new Set<string>();
  let installs = 0;
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.run || !/\bnpm\s+(?:ci|install)\b/.test(step.run)) continue;
      const environment: Environment = { ...workflow.env, ...job.env, ...step.env };
      assert.equal(environment.ONNXRUNTIME_NODE_INSTALL, 'skip', `${jobId}: ${step.name}`);
      assert.doesNotMatch(step.run, /--ignore-scripts\b/, 'dependency lifecycle scripts must remain enabled');
      installJobs.add(jobId);
      installs += 1;
    }
  }
  assert.deepEqual([...installJobs].sort(), Object.keys(workflow.jobs).sort());
  assert.ok(installs > installJobs.size, 'include the nested AgenticReplay installs');
});
