import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { captureProfileProbeContext, probeProfileMemory } from '../dist/akinator/memory-probe.js';
import { profileFixture } from './akinator-memory-fixture.mjs';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
const base = { taskType: 'build', target: null, expected: null, constraints: null };
const cases = [
  { name: 'exact_target', query: 'Implement src/alpha.ts', targets: ['src/alpha.ts'], adopt: 'src/alpha.ts' },
  { name: 'negated_target', query: 'Do not change src/alpha.ts', targets: ['src/alpha.ts'], adopt: null },
  { name: 'example_only', query: 'Example src/alpha.ts', targets: ['src/alpha.ts'], adopt: null },
  { name: 'vague_target', query: 'Implement alpha', targets: ['src/alpha.ts'], adopt: null },
  { name: 'conflicting_targets', query: 'Implement src/alpha.ts', targets: ['src/alpha.ts', 'src/other.ts'], adopt: null },
  { name: 'current_target', query: 'Implement src/alpha.ts', targets: ['src/alpha.ts'], current: 'src/current.ts', adopt: 'src/current.ts' },
  { name: 'incomplete_run', query: 'Implement src/alpha.ts', targets: ['src/alpha.ts'], completed: false, adopt: null },
  { name: 'missing_path', query: 'Implement src/missing.ts', targets: ['src/missing.ts'], adopt: null },
  { name: 'partial_index', query: 'Implement src/alpha.ts', targets: ['src/alpha.ts'], partial: true, adopt: null },
  { name: 'japanese_query', query: 'src/alpha.ts を修正', targets: ['src/alpha.ts'], adopt: 'src/alpha.ts' },
];
const results = [];
for (const scenario of cases) {
  const fixture = profileFixture();
  try {
    for (const target of scenario.targets) fixture.source(target, scenario.completed ?? true);
    if (scenario.partial) fixture.database.exec('DELETE FROM akinator_profile_documents');
    const profile = { ...base, target: scenario.current ?? null };
    const context = captureProfileProbeContext(fixture.project, scenario.query, 'resolve');
    const result = probeProfileMemory(fixture.database, context, scenario.query, profile);
    assert.equal(result.profile.target, scenario.adopt, scenario.name);
    assert.equal(result.profile.expected, null);
    assert.equal(result.profile.constraints, null);
    results.push({ case: scenario.name, passed: true, adopted: result.resolution.adopted !== null,
      candidates: result.resolution.scannedCandidates, status: result.resolution.status });
  } finally { fixture.close(); }
}
const report = { policyVersion: 'profile-memory-v1', evaluated: results.length, incorrectAdoptions: 0,
  evidence: 'deterministic fixtures; no production correction rates or task-token savings measured', results };
if (values.output !== undefined) writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report) + '\n');
