import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeCompactionState } from '../../src/opencode/compaction.js';

function activeOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    run: { runId: 'run-one' },
    project: { workspace: 'project:workspace-one' },
    contextRevision: 7,
    executionLease: { leaseToken: 'lease-one', routeEpoch: 3 },
    ennoOduno: {
      applicable: true,
      status: 'goki_executing',
      orchestrationId: 'orchestration-one',
      contractRevision: 4,
      routeEpoch: 3,
      currentRole: 'goki',
      nextAction: 'execute_work_unit',
      directive: {
        runId: 'run-one',
        workUnit: { id: 'unit-one' },
        reportSchema: { required: ['runId', 'expectedRevision', 'leaseToken'] },
      },
    },
    ...overrides,
  });
}

test('compaction state appends exact successful Enno continuation fields only to the owning session', () => {
  const state = new OpenCodeCompactionState();
  state.observe('session-one', 'kiokuko_task_prepare', activeOutput());
  const ownerContext: string[] = [];
  const otherContext: string[] = [];
  state.appendContext('session-one', ownerContext);
  state.appendContext('session-two', otherContext);
  assert.equal(ownerContext.length, 1);
  assert.deepEqual(otherContext, []);
  assert.match(ownerContext[0]!, /"workspace":"project:workspace-one"/u);
  assert.match(ownerContext[0]!, /"orchestrationId":"orchestration-one"/u);
  assert.match(ownerContext[0]!, /"contractRevision":4/u);
  assert.match(ownerContext[0]!, /task_context_read.*afterContextRevision equal to contextRevision/u);
  assert.match(ownerContext[0]!, /"contextRevision":7/u);
  assert.match(ownerContext[0]!, /"leaseToken":"lease-one"/u);
});

test('compaction state ignores failed output and clears stale leases after Goki advances', () => {
  const state = new OpenCodeCompactionState();
  state.observe('session-one', 'kiokuko_task_prepare', activeOutput());
  state.observe('session-one', 'kiokuko_enno_work_report', 'Request is invalid');
  state.observe('session-one', 'kiokuko_enno_work_report', JSON.stringify({
    ennoOduno: {
      applicable: true,
      status: 'enno_verifying',
      orchestrationId: 'orchestration-one',
      contractRevision: 4,
      routeEpoch: 3,
      currentRole: 'enno-oduno',
      nextAction: 'prepare_final_verification',
      directive: { runId: 'run-one', workUnit: null, reportSchema: { required: ['runId'] } },
    },
  }));
  const context: string[] = [];
  state.appendContext('session-one', context);
  assert.equal(context.length, 1);
  assert.match(context[0]!, /"status":"enno_verifying"/u);
  assert.match(context[0]!, /"executionLease":null/u);
  assert.doesNotMatch(context[0]!, /lease-one/u);
});

test('compaction state removes terminal runs and never carries identity into another run', () => {
  const state = new OpenCodeCompactionState();
  state.observe('session-one', 'kiokuko_task_prepare', activeOutput());
  state.observe('session-one', 'kiokuko_enno_meditation_submit', JSON.stringify({
    ennoOduno: { applicable: true, status: 'completed' },
  }));
  const terminalContext: string[] = [];
  state.appendContext('session-one', terminalContext);
  assert.deepEqual(terminalContext, []);

  state.observe('session-one', 'kiokuko_task_prepare', activeOutput());
  state.observe('session-one', 'kiokuko_enno_verify_prepare', JSON.stringify({
    project: { workspace: 'project:workspace-two' },
    ennoOduno: {
      applicable: true,
      status: 'enno_verifying',
      contractRevision: 1,
      routeEpoch: 0,
      currentRole: 'enno-oduno',
      nextAction: 'finish_review',
      directive: { runId: 'run-two', workUnit: null, reportSchema: { required: ['runId'] } },
    },
  }));
  const switchedContext: string[] = [];
  state.appendContext('session-one', switchedContext);
  assert.deepEqual(switchedContext, []);
});
