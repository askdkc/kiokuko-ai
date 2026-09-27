import { applyEdits, modify, parse } from 'jsonc-parser';
import { canonicalContentHash } from '../serialization/validate.js';
import { KiokukoError } from '../errors.js';
import { MANAGED_EXECUTION_AGENTS, object, orchestrationOptionsSchema } from '../execution/catalog.js';

/** Extend only the managed plugin object and absent or unmodified managed agents. */
export function renderExecutionConfig(source: string, pluginIndex: number, mode?: 'ask' | 'on' | 'off'): string {
  const root = object(parse(source));
  if (root.agents !== undefined && (typeof root.agents !== 'object' || root.agents === null || Array.isArray(root.agents))) {
    throw new KiokukoError('VALIDATION_ERROR', 'OpenCode agents must be an object');
  }
  const plugins = root.plugins as unknown[];
  const entry = object(plugins[pluginIndex]);
  const priorOptions = object(entry.options);
  const priorOrchestration = priorOptions.orchestration ?? {};
  const options = orchestrationOptionsSchema.parse(priorOrchestration);
  if (mode !== undefined) options.mode = mode;
  const owned = object(priorOptions.orchestrationManagedAgents);
  const hashes = { ...owned };
  const agents = object(root.agents);
  const legacyAgents = object(root.agent);
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' };
  let content = source;
  const set = (keys: (string | number)[], value: unknown) => {
    content = applyEdits(content, modify(content, keys, value, { formattingOptions }));
  };
  for (const [agent, definition] of Object.entries(MANAGED_EXECUTION_AGENTS)) {
    const legacy = legacyAgents[agent];
    if (legacy !== undefined && owned[agent] !== canonicalContentHash(legacy)) {
      throw new KiokukoError('CONFLICT', `Legacy OpenCode agent has unowned changes: ${agent}`);
    }
    const existing = agents[agent];
    if (existing !== undefined && owned[agent] !== canonicalContentHash(existing)) {
      if (owned[agent] === undefined && canonicalContentHash(existing) !== canonicalContentHash(definition)) {
        throw new KiokukoError('CONFLICT', `OpenCode agent name is already owned by the user: ${agent}`);
      }
      if (owned[agent] !== undefined) continue; // Preserve user edits, including their original ownership digest.
    }
    if (existing === undefined || canonicalContentHash(existing) !== canonicalContentHash(definition)) set(['agents', agent], definition);
    if (legacy !== undefined) set(['agent', agent], undefined);
    hashes[agent] = canonicalContentHash(definition);
  }
  if (object(root.experimental).subagent_depth === undefined) set(['experimental', 'subagent_depth'], 2);
  if (priorOptions.orchestration === undefined) set(['plugins', pluginIndex, 'options', 'orchestration'], options);
  else {
    if (object(priorOptions.orchestration).mode !== options.mode) set(['plugins', pluginIndex, 'options', 'orchestration', 'mode'], options.mode);
    if (object(priorOptions.orchestration).customAgents === undefined) set(['plugins', pluginIndex, 'options', 'orchestration', 'customAgents'], options.customAgents);
  }
  if (priorOptions.orchestrationSubagentDepth !== 2) set(['plugins', pluginIndex, 'options', 'orchestrationSubagentDepth'], 2);
  if (canonicalContentHash(owned) !== canonicalContentHash(hashes)) set(['plugins', pluginIndex, 'options', 'orchestrationManagedAgents'], hashes);
  return content;
}
