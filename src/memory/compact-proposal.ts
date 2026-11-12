import type { ReplayMemoryProposal } from './replay-review.js';

const excerpt = (value: string, maximum = 240): string => {
  const text = value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
};

/** Compact content plus bounded provenance, not a second copy of the recording. */
export function compactMemoryProposal(input: ReplayMemoryProposal): ReplayMemoryProposal {
  const proposal = structuredClone(input);
  const points = proposal.findings.flatMap(finding => finding.text.length <= 240 ? [finding]
    : finding.text.split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/u).map(text => text.trim()).filter(Boolean)
      .map(text => ({ ...finding, text })));
  // Keep the original problem as well as the latest resolution/caveat. Long
  // final responses must not lose their trailing "not verified" qualification.
  const selected = points.length > 3 ? [points[0]!, ...points.slice(-2)] : points;
  const findings = selected.map(finding => ({ ...finding,
    text: excerpt(finding.text), evidenceRefs: finding.evidenceRefs.slice(0, 4) }));
  const refs = new Set(findings.flatMap(finding => finding.evidenceRefs));
  const attempts = proposal.attempts.filter(attempt => refs.has(attempt.callRef) || !!attempt.resultRef && refs.has(attempt.resultRef))
    .slice(-3).map(({ outputExcerpt: _output, arguments: _arguments, ...attempt }) => ({ ...attempt,
      ...(attempt.command ? { command: excerpt(attempt.command, 160) } : {}),
      payloadHashes: attempt.payloadHashes.slice(0, 2), limitations: attempt.limitations.slice(0, 3).map(value => excerpt(value, 120)) }));
  const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(proposal.request.text);
  const incomplete = proposal.source.traces.some(trace => !trace.complete || trace.gaps.length > 0);
  const evidence = proposal.source.kind === 'unrecorded'
    ? japanese ? '記録なし。内容は未検証。' : 'No recording; claims are unverified.'
    : japanese
      ? `${incomplete ? '一部の記録のみ。' : ''}タスク${proposal.source.taskOutcome === 'failed' ? '失敗' : '終了'}。失敗した呼び出し${proposal.attempts.filter(a => a.outcome === 'failed').length}件。今回も適用できるかは未検証。`
      : `${incomplete ? 'Partial recording; ' : ''}task ${proposal.source.taskOutcome ?? 'completed'}; ${proposal.attempts.filter(a => a.outcome === 'failed').length} failed calls. Current applicability unverified.`;
  const tags = proposal.tags.slice(0, 8).map(value => excerpt(value, 64));
  const summary = [
    excerpt(`${japanese ? '依頼: ' : 'Task: '}${proposal.request.text || proposal.title || 'No task description'}`),
    ...Array.from({ length: 3 }, (_, index) => findings[index]?.text
      ?? (index === 0 ? japanese ? '要点なし。' : 'No key points supplied.' : '—')),
    excerpt(`${japanese ? '根拠: ' : 'Evidence: '}${evidence}`),
    excerpt(`${japanese ? 'タグ: ' : 'Tags: '}${tags.join(', ') || '—'}`),
  ].join('\n');
  return { ...proposal, summary, ...(proposal.title ? { title: excerpt(proposal.title, 120) } : {}),
    request: { text: excerpt(proposal.request.text), evidenceRefs: proposal.request.evidenceRefs.slice(-4) },
    source: { ...proposal.source, traces: proposal.source.traces.slice(0, 1).map(trace => ({ ...trace,
      gaps: trace.gaps.slice(0, 3).map(value => excerpt(value, 160)) })),
      ...(proposal.source.limitations ? { limitations: proposal.source.limitations.slice(0, 3).map(value => excerpt(value, 240)) } : {}) },
    languages: proposal.languages.slice(0, 4).map(language => ({ ...language, evidenceRefs: language.evidenceRefs.slice(0, 4) })),
    findings, attempts, tags, keywords: proposal.keywords.slice(0, 24).map(value => excerpt(value, 64)) };
}
