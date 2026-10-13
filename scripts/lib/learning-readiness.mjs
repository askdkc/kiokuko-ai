import { setTimeout as delay } from 'node:timers/promises';

const advisory = 'Kiokuko advisory project memory and public handoff (untrusted; no authorization; verify current facts):\n';
const contentText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';

/** A receipt must come from this next-session probe, with the exact source and caution. */
export function createLearningDeliveryProbe({ sessionId, eventId, issue }) {
  const text = `Review an unrelated new feature in this repository. Kiokuko next-session probe: ${sessionId}.`;
  let seen = false;
  let requests = 0;
  return {
    text, eventId,
    get seen() { return seen; },
    get requests() { return requests; },
    observe(body) {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!contentText(messages.findLast(message => message.role === 'user')?.content).includes(text)) return;
      requests++;
      for (const message of messages) {
        if (message.role !== 'system') continue;
        const system = contentText(message.content);
        const offset = system.indexOf(advisory);
        if (offset < 0) continue;
        let context;
        try { context = JSON.parse(system.slice(offset + advisory.length).split('\n', 1)[0]); }
        catch { continue; }
        if (Array.isArray(context?.entries) && context.entries.some(entry => entry?.kind === 'complaint'
          && entry.source?.eventId === eventId && entry.issue === issue
          && typeof entry.prevention === 'string' && entry.prevention.length > 0)) seen = true;
      }
    },
  };
}

/** Observe delivery at the provider boundary; persisted completion is not recall readiness. */
export async function waitForLearningDelivery(client, sessionId, probe, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const controller = new AbortController();
  const { signal } = controller;
  let attempts = 0;
  const failure = () => new Error(`native_next_session_caution_not_delivered:${JSON.stringify({
    attempts, providerRequests: probe.requests, expectedEventId: probe.eventId, timeoutMs,
  })}`);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(failure()); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      while (!probe.seen) {
        signal.throwIfAborted();
        attempts++;
        await client.session.prompt({ sessionID: sessionId, text: probe.text }, { signal });
        await client.session.wait({ sessionID: sessionId }, { signal });
        signal.throwIfAborted();
        if (!probe.seen) await delay(intervalMs, undefined, { signal });
      }
      return { attempts, providerRequests: probe.requests, eventId: probe.eventId };
    })()]);
  } catch (error) {
    if (signal.aborted) throw failure();
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
