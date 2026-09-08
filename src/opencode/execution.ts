import type { PluginInput, Hooks } from '@opencode-ai/plugin';
import * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { buildExecutionCatalog, EXECUTION_ROLES, object, orchestrationOptionsSchema, roleRegistrations } from '../execution/catalog.js';
import { readKiokukoExecutionRouting, type HookEffectDependencies } from './hook-effect.js';

const markerSchema = z.object({ runId: z.string().min(1).max(256), revision: z.number().int().min(1), role: z.enum(EXECUTION_ROLES) }).strict();
const MARKER = /^<kiokuko-execution>([^\n]{1,1024})<\/kiokuko-execution>\n/u;
const READ_TIMEOUT_MS = 5_000;

/** Model routing uses standard task agent names; this hook never changes a model. */
export function createExecutionHooks(
  client: PluginInput['client'], directory: string, rawOptions: unknown,
  dependencies: HookEffectDependencies & { readRouting?: typeof readKiokukoExecutionRouting } = {},
): Pick<Hooks, 'event' | 'config' | 'tool.execute.before' | 'tool.execute.after'> {
  const options = orchestrationOptionsSchema.parse(object(rawOptions).orchestration ?? {});
  let config: unknown = {};
  const preparedCatalogs = new Map<string, ReturnType<typeof buildExecutionCatalog>>();
  const inFlight = new Map<string, { model: string; root: string; dispatch: Parameters<typeof readKiokukoExecutionRouting>[0] }>();
  const failures = new Set<string>();
  const request = () => ({ signal: dependencies.signal
    ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]) : AbortSignal.timeout(READ_TIMEOUT_MS) });
  const data = (response: unknown) => object(response).data;
  const catalog = async () => {
    let providers: unknown;
    try { providers = data(await client.provider.list({ ...request(), query: { directory } })); }
    catch { providers = {}; }
    return buildExecutionCatalog(config, providers, options);
  };
  const ancestry = async (sessionID: string) => {
    const chain: Array<{ id: string; agent?: string }> = [];
    let id = sessionID;
    for (let depth = 0; depth < 4; depth++) {
      const session = object(data(await client.session.get({ path: { id }, ...request() })));
      if (session.id !== id || chain.some(item => item.id === id)) throw new KiokukoError('CONFLICT', 'Invalid execution session ancestry');
      chain.push({ id, ...(typeof session.agent === 'string' ? { agent: session.agent } : {}) });
      if (typeof session.parentID !== 'string') return chain;
      id = session.parentID;
    }
    throw new KiokukoError('CONFLICT', 'Execution session nesting is too deep');
  };
  const failed = async (sessionID: string, callID: string) => {
    const flightKey = `${sessionID}:${callID}`;
    const entry = inFlight.get(flightKey);
    if (!entry) return;
    inFlight.delete(flightKey);
    failures.add(entry.root);
    await (dependencies.readRouting ?? readKiokukoExecutionRouting)({ ...entry.dispatch, stage: 'failed' }, dependencies);
  };
  return {
    event: async ({ event }) => {
      const part = object(object(object(event).properties).part);
      if (object(event).type === 'message.part.updated' && part.type === 'tool' && object(part.state).status === 'error' && typeof part.callID === 'string' && typeof part.sessionID === 'string') {
        await failed(part.sessionID, part.callID);
      }
    },
    config: async value => { config = value; },
    'tool.execute.before': async ({ tool, sessionID, callID }, output) => {
      const args = object(output.args);
      if (/(?:^|_)task_prepare$/u.test(tool)) {
        const key = `${sessionID}:${String(args.requestId)}`;
        // Preserve bound input on an exact retry; availability is refreshed at selection/dispatch.
        let current = preparedCatalogs.get(key);
        if (!current) {
          current = await catalog(); preparedCatalogs.set(key, current);
          if (preparedCatalogs.size > 256) preparedCatalogs.delete(preparedCatalogs.keys().next().value!);
        }
        // OpenCode 1.18.25/26 executes the original args reference after the
        // hook. Replacing output.args would silently discard this metadata.
        Object.assign(args, { client: { ...object(args.client), kind: 'opencode', sessionId: sessionID }, executionCatalog: current });
        return;
      }
      if (/(?:^|_)task_execution_select$/u.test(tool)) {
        const chain = await ancestry(sessionID);
        if (chain.length !== 1) throw new KiokukoError('CONFLICT', 'Only the parent may select execution');
        await (dependencies.readRouting ?? readKiokukoExecutionRouting)({ runId: String(args.runId), rootSessionId: sessionID, cwd: directory }, dependencies);
        Object.assign(args, { catalog: await catalog() });
        failures.delete(sessionID);
        return;
      }
      if (tool !== 'task') return;
      const registered = roleRegistrations(options).some(item => item.agent === args.subagent_type);
      const match = typeof args.prompt === 'string' ? MARKER.exec(args.prompt) : null;
      const chain = await ancestry(sessionID);
      const callerRegistered = roleRegistrations(options).some(item => item.agent === chain[0]?.agent);
      if (!registered && !match && !callerRegistered) return;
      if (!match) throw new KiokukoError('CONFLICT', 'Select an execution configuration first, then use its exact dispatch promptPrefix');
      const marker = markerSchema.parse(JSON.parse(match[1]!));
      const root = chain.at(-1)!.id;
      if (failures.has(root)) throw new KiokukoError('CONFLICT', 'The previous model call failed. Select another model, ordinary work, or cancel before retrying.');
      const route = object(await (dependencies.readRouting ?? readKiokukoExecutionRouting)({ runId: marker.runId, rootSessionId: root, cwd: directory }, dependencies));
      if (route.modelFailure) throw new KiokukoError('CONFLICT', 'A selected model failed. Select another configuration, ordinary work, or cancel.');
      // The host error is durable even if the plugin was disposed before its asynchronous failure write completed.
      for (const session of chain) {
        const messages = data(await client.session.messages({ path: { id: session.id }, query: { limit: 50 }, ...request() }));
        if (!Array.isArray(messages)) throw new KiokukoError('CONFLICT', 'Cannot verify earlier role results');
        for (const message of messages) for (const value of Array.isArray(object(message).parts) ? object(message).parts as unknown[] : []) {
          const part = object(value);
          if (part.type !== 'tool' || part.tool !== 'task' || object(part.state).status !== 'error') continue;
          const oldPrompt = object(object(part.state).input).prompt;
          const oldMatch = typeof oldPrompt === 'string' ? MARKER.exec(oldPrompt) : null;
          if (!oldMatch) continue;
          let old;
          try { old = markerSchema.safeParse(JSON.parse(oldMatch[1]!)); } catch { continue; }
          if (old.success && old.data.runId === marker.runId && old.data.revision === marker.revision) {
            throw new KiokukoError('CONFLICT', 'A role call failed in this selection. Select another configuration, ordinary work, or cancel.');
          }
        }
      }
      const selected = object(route.selected);
      const expected = object(selected[marker.role]);
      const roleAllowed = chain.length === 1 ? marker.role === route.role : chain.length === 2
        && marker.role === 'gokiWorker' && route.role === 'gokiHead' && chain[0]?.agent === object(selected.gokiHead).agent;
      if (!route.active || route.choice !== 'enno' || route.revision !== marker.revision || !roleAllowed || expected.agent !== args.subagent_type) {
        throw new KiokukoError('CONFLICT', 'Task role, run, selection revision or selected agent changed');
      }
      const current = (await catalog()).candidates.find(item => item.role === marker.role && item.agent === args.subagent_type);
      if (!current || current.unavailable || current.configurationDigest !== expected.configurationDigest || current.model !== expected.model) {
        throw new KiokukoError('CONFLICT', `Selected agent is unavailable or changed (${current?.unavailable ?? 'configuration_changed'}). Select another model, ordinary work, or cancel.`);
      }
      // Do not reuse a child session from another run/configuration. Continuation remains parent-owned.
      if (args.task_id) throw new KiokukoError('CONFLICT', 'Delegated phases require a fresh child session');
      if (args.background === true) throw new KiokukoError('CONFLICT', 'Await the selected role before advancing the orchestration');
      const dispatch = { runId: marker.runId, rootSessionId: root, cwd: directory, revision: marker.revision, role: marker.role,
        agent: current.agent, promptDigest: canonicalContentHash(args.prompt), callId: callID };
      await (dependencies.readRouting ?? readKiokukoExecutionRouting)({ ...dispatch, stage: 'begin' }, dependencies);
      inFlight.set(`${sessionID}:${callID}`, { model: current.model, root, dispatch });
    },
    'tool.execute.after': async ({ tool, callID, sessionID }, output) => {
      if (tool !== 'task') return;
      const flightKey = `${sessionID}:${callID}`;
      const expected = inFlight.get(flightKey);
      if (!expected) return;
      const metadata = object(output.metadata);
      const model = object(metadata.model);
      if (`${String(model.providerID)}/${String(model.modelID)}` !== expected.model || /<task_error>|state="error"/u.test(output.output)) {
        await failed(sessionID, callID);
        throw new KiokukoError('CONFLICT', 'Selected model failed or dispatch metadata did not match. Select another model, ordinary work, or cancel.');
      }
      await (dependencies.readRouting ?? readKiokukoExecutionRouting)({ ...expected.dispatch, stage: 'complete' }, dependencies);
      inFlight.delete(flightKey);
      output.metadata = { ...metadata, kiokukoModelVerified: canonicalContentHash(expected.model) };
    },
  };
}
