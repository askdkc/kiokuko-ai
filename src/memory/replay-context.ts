import type { ReplayMemoryProposal } from './replay-review.js';

/** A bounded historical evidence preview, never proof that advice applies now.
 * Keep interpretation and recorded execution separate; no raw output or arguments.
 */
export function approvedReplayContext(proposal: ReplayMemoryProposal) {
  const taskBinding = (taskId?: string | null) => taskId == null ? 'unassigned'
    : taskId === proposal.source.taskId ? 'reviewed_task' : 'other_task';
  const selected = proposal.findings.slice(-2);
  const linked = new Set(selected.flatMap(finding => finding.evidenceRefs));
  const attempts = [...proposal.attempts].sort((a, b) =>
    Number(linked.has(b.callRef) || !!b.resultRef && linked.has(b.resultRef))
      - Number(linked.has(a.callRef) || !!a.resultRef && linked.has(a.resultRef)))
    .slice(0, 3).map(attempt => ({
      callRef: attempt.callRef, ...(attempt.resultRef ? { resultRef: attempt.resultRef } : {}),
      taskId: attempt.taskId ?? null,
      taskBinding: taskBinding(attempt.taskId),
      tool: attempt.tool, ...(attempt.command ? { command: attempt.command.slice(0, 160),
        commandTruncated: attempt.command.length > 160 } : {}),
      execution: attempt.execution, outcome: attempt.outcome,
      ...(attempt.exitCode === undefined ? {} : { exitCode: attempt.exitCode }),
      limitations: attempt.limitations.slice(0, 1).map(value => value.slice(0, 100)),
      limitationsTruncated: attempt.limitations.slice(0, 1).some(value => value.length > 100),
      limitationsOmitted: Math.max(0, attempt.limitations.length - 1),
    }));
  const included = new Set(attempts.flatMap(attempt => [attempt.callRef, ...(attempt.resultRef ? [attempt.resultRef] : [])]));
  const findings = selected.map(finding => ({
    kind: finding.kind, taskId: finding.taskId ?? null, taskBinding: taskBinding(finding.taskId),
    text: finding.text.slice(0, 240), textTruncated: finding.text.length > 240,
    basis: finding.basis, evidenceRefs: finding.evidenceRefs.slice(0, 4),
    evidenceRefsOmitted: Math.max(0, finding.evidenceRefs.length - 4),
    evidenceStatus: !finding.evidenceRefs.length ? 'not_provided'
      : finding.evidenceRefs.length <= 4 && finding.evidenceRefs.every(ref => included.has(ref))
        ? 'recorded_attempts' : 'references_only',
  }));
  return {
    entryId: proposal.proposalId, revision: proposal.revision, kind: proposal.source.kind === 'unrecorded' ? 'reviewed_unrecorded' : 'reviewed_replay',
    summary: findings.map(finding => finding.text).join('\n'), findings, attempts,
    request: proposal.request.text.slice(0, 240), requestTruncated: proposal.request.text.length > 240,
    tags: proposal.tags.slice(0, 8),
    source: { ...proposal.source, traces: proposal.source.traces.slice(0, 1).map(trace => ({
      ...trace, gaps: trace.gaps.slice(0, 1).map(value => value.slice(0, 100)),
      gapsTruncated: trace.gaps.slice(0, 1).some(value => value.length > 100),
      gapsOmitted: Math.max(0, trace.gaps.length - 1),
    })) },
    omitted: { findings: Math.max(0, proposal.findings.length - findings.length),
      attempts: Math.max(0, proposal.attempts.length - attempts.length),
      traces: Math.max(0, proposal.source.traces.length - 1), tags: Math.max(0, proposal.tags.length - 8) },
    verification: 'user_reviewed_not_task_verified', currentApplicability: 'unverified', untrusted: true,
  };
}
