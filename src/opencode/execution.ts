import type { Plugin } from '@opencode/plugin';
import * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { buildExecutionCatalog, EXECUTION_ROLES, object, orchestrationOptionsSchema, roleRegistrations } from '../execution/catalog.js';
import { readKiokukoExecutionRouting, type HookEffectDependencies } from './hook-effect.js';

type Context = Plugin.Context;
const markerSchema = z.object({ runId: z.string().min(1).max(256), revision: z.number().int().min(1), role: z.enum(EXECUTION_ROLES) }).strict();
const MARKER = /^<kiokuko-execution>([^\n]{1,1024})<\/kiokuko-execution>\n/u;
interface Dispatch { runId: string; rootSessionId: string; cwd: string; revision: number; role: string; agent: string; promptDigest: string; callId: string }
interface Flight { dispatch: Dispatch; parentID: string; model: string; configurationDigest: string; childID?: string }

function resultSession(value: unknown): { sessionID: string; status: 'completed' | 'running' } | null {
  const root = object(value);
  const metadata = object(root.metadata);
  if (typeof metadata.sessionID !== 'string' || (metadata.status !== 'completed' && metadata.status !== 'running')) return null;
  return { sessionID: metadata.sessionID, status: metadata.status };
}

/** V2 guards apply to native tool calls and Code Mode calls alike. */
export async function registerExecutionHooks(
  ctx: Context, directory: string, dependencies: HookEffectDependencies,
  routing: typeof readKiokukoExecutionRouting = readKiokukoExecutionRouting,
): Promise<{ onSessionEnded(sessionID: string): Promise<void> }> {
  const options = orchestrationOptionsSchema.parse(object(ctx.options).orchestration ?? {});
  const prepared = new Map<string, ReturnType<typeof buildExecutionCatalog>>();
  const inFlight = new Map<string, Flight>();
  const failures = new Set<string>();
  const catalog = async () => {
    const [agents, models, providers] = await Promise.all([ctx.agent.list(), ctx.model.list(), ctx.provider.list()]);
    return buildExecutionCatalog({ agents: agents.data, models: models.data, providers: providers.data,
      subagentDepth: object(ctx.options).orchestrationSubagentDepth === 2 ? 2 : 1 }, options);
  };
  const ancestry = async (sessionID: string) => {
    const chain: Array<{ id: string; agent?: string }> = [];
    let id = sessionID;
    for (let depth = 0; depth < 4; depth++) {
      const session = await ctx.session.get({ sessionID: id });
      if (session.id !== id || session.location.directory !== directory || session.projectID !== ctx.location.project.id
        || chain.some(item => item.id === id)) throw new KiokukoError('CONFLICT', 'Invalid execution ancestry');
      chain.push({ id, ...(session.agent ? { agent: session.agent } : {}) });
      if (!session.parentID) return chain;
      id = session.parentID;
    }
    throw new KiokukoError('CONFLICT', 'Execution nesting is too deep');
  };
  const failed = async (key: string) => {
    const flight = inFlight.get(key);
    if (!flight) return;
    inFlight.delete(key);
    failures.add(flight.dispatch.rootSessionId);
    await routing({ ...flight.dispatch, stage: 'failed' }, dependencies);
  };
  const complete = async (key: string, childID: string) => {
    const flight = inFlight.get(key);
    if (!flight || flight.childID !== childID) throw new KiokukoError('CONFLICT', 'Unknown child dispatch');
    const child = await ctx.session.get({ sessionID: childID });
    const messages = await ctx.session.context({ sessionID: childID });
    const assistant = [...messages].reverse().find(item => item.type === 'assistant');
    const model = flight.model.split('#');
    const valid = child.id === childID && child.parentID === flight.parentID
      && child.location.directory === directory && child.projectID === ctx.location.project.id
      && child.agent === flight.dispatch.agent && child.outcome === 'succeeded'
      && assistant?.type === 'assistant' && assistant.time.completed !== undefined
      && `${assistant.model.providerID}/${assistant.model.id}` === model[0]
      && (model.length === 1 || assistant.model.variant === model[1]);
    const current = (await catalog()).candidates.find(item => item.role === flight.dispatch.role && item.agent === flight.dispatch.agent);
    if (!valid || !current || current.unavailable || current.configurationDigest !== flight.configurationDigest) {
      await failed(key);
      throw new KiokukoError('CONFLICT', 'Subagent result, model or configuration was not verified');
    }
    await routing({ ...flight.dispatch, stage: 'complete' }, dependencies);
    inFlight.delete(key);
  };
  await ctx.tool.hook('execute.before', async event => {
    const args = object(event.input);
    if (/(?:^|_)task_prepare$/u.test(event.tool)) {
      const key = `${event.sessionID}:${String(args.requestId)}`;
      let value = prepared.get(key);
      if (!value) { value = await catalog(); prepared.set(key, value); }
      Object.assign(args, { client: { ...object(args.client), kind: 'opencode', sessionId: event.sessionID }, executionCatalog: value });
      event.input = args;
      return;
    }
    if (/(?:^|_)task_execution_select$/u.test(event.tool)) {
      if ((await ancestry(event.sessionID)).length !== 1) throw new KiokukoError('CONFLICT', 'Only parent may select execution');
      await routing({ runId: String(args.runId), rootSessionId: event.sessionID, cwd: directory }, dependencies);
      args.catalog = await catalog();
      event.input = args;
      failures.delete(event.sessionID);
      return;
    }
    if (event.tool !== 'subagent') return;
    const chain = await ancestry(event.sessionID);
    const match = typeof args.prompt === 'string' ? MARKER.exec(args.prompt) : null;
    const registered = roleRegistrations(options);
    if (!match && !registered.some(item => item.agent === args.agent || item.agent === chain[0]?.agent)) return;
    if (!match) throw new KiokukoError('CONFLICT', 'Missing exact dispatch promptPrefix');
    const marker = markerSchema.parse(JSON.parse(match[1]!));
    const root = chain.at(-1)!.id;
    if (failures.has(root)) throw new KiokukoError('CONFLICT', 'Previous model call failed; select again');
    const route = object(await routing({ runId: marker.runId, rootSessionId: root, cwd: directory }, dependencies));
    const selected = object(route.selected);
    const expected = object(selected[marker.role]);
    const allowed = chain.length === 1 ? marker.role === route.role : chain.length === 2 && marker.role === 'gokiWorker'
      && route.role === 'gokiHead' && chain[0]?.agent === object(selected.gokiHead).agent;
    if (!route.active || route.choice !== 'enno' || route.modelFailure || route.revision !== marker.revision || !allowed
      || expected.agent !== args.agent) throw new KiokukoError('CONFLICT', 'Execution selection changed');
    const current = (await catalog()).candidates.find(item => item.role === marker.role && item.agent === args.agent);
    if (!current || current.unavailable || current.configurationDigest !== expected.configurationDigest || current.model !== expected.model) {
      throw new KiokukoError('CONFLICT', 'Selected role or model is unavailable or changed');
    }
    if (args.background === true || args.sessionID !== undefined) throw new KiokukoError('CONFLICT', 'Selected role needs a new foreground child');
    if (args.model !== undefined && args.model !== current.model) throw new KiokukoError('CONFLICT', 'Model override differs from selection');
    args.model = current.model;
    event.input = args;
    const dispatch: Dispatch = { runId: marker.runId, rootSessionId: root, cwd: directory, revision: marker.revision,
      role: marker.role, agent: current.agent, promptDigest: canonicalContentHash(args.prompt), callId: event.id };
    await routing({ ...dispatch, stage: 'begin' }, dependencies);
    inFlight.set(`${event.sessionID}:${event.id}`, { dispatch, parentID: event.sessionID, model: current.model, configurationDigest: current.configurationDigest });
  });
  await ctx.tool.hook('execute.after', async event => {
    if (event.tool !== 'subagent') return;
    const key = `${event.sessionID}:${event.id}`;
    const flight = inFlight.get(key);
    if (!flight) return;
    if (event.status === 'error') { await failed(key); return; }
    const result = resultSession(event.result);
    if (!result) { await failed(key); throw new KiokukoError('CONFLICT', 'Subagent result lacks session status'); }
    flight.childID = result.sessionID;
    if (result.status === 'completed') await complete(key, result.sessionID);
  });
  return { onSessionEnded: async sessionID => {
    for (const [key, flight] of inFlight) if (flight.childID === sessionID) {
      try { await complete(key, sessionID); } catch { await failed(key); }
    }
  } };
}
