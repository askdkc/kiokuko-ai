// Provider-reported OpenCode counters remain separate. Missing counters are unknown, never zero.
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function summarizeSourceLlmMessages(messages) {
  const assistants = messages.filter(m => m.info?.role === 'assistant');
  // OpenCode may normalize an absent provider usage event to all-zero counters.
  // Do not report those as evidence of free inference.
  const usageObserved = assistants.length > 0 && assistants.every(m=> {
    const t=m.info.tokens;
    return t && [t.input,t.output,t.reasoning,t.cache?.read,t.cache?.write].every(finite)
      && t.input+t.cache.read+t.cache.write+t.output+t.reasoning > 0;
  });
  const sum = select => {
    const values = assistants.map(select);
    return usageObserved && values.every(finite) ? values.reduce((a,b)=>a+b,0) : null;
  };
  const tools = assistants.flatMap(m => m.parts ?? []).filter(p=>p.type === 'tool');
  return {
    assistantMessages: assistants.length,
    usageObserved,
    input: sum(m=>m.info.tokens?.input), output: sum(m=>m.info.tokens?.output), reasoning: sum(m=>m.info.tokens?.reasoning),
    cacheRead: sum(m=>m.info.tokens?.cache?.read), cacheWrite: sum(m=>m.info.tokens?.cache?.write),
    reportedCost: sum(m=>m.info.cost), errors: assistants.filter(m=>m.info.error).map(m=>m.info.error.name ?? 'unknown'),
    tools: Object.fromEntries([...new Set(tools.map(p=>p.tool))].sort().map(name=>[name,tools.filter(p=>p.tool === name).length])),
    completedReads: tools.filter(p=>p.tool === 'read' && p.state?.status === 'completed').length,
    toolOutputBytes: tools.filter(p=>p.state?.status === 'completed').reduce((n,p)=>n+Buffer.byteLength(p.state.output ?? ''),0),
  };
}

export function finalSourceLlmText(messages) {
  const final = messages.filter(m=>m.info?.role === 'assistant').at(-1);
  return final ? (final.parts ?? []).filter(p=>p.type === 'text').map(p=>p.text).join('\n') : '';
}
