import type { ContextBrokerPersistence } from '../../context/broker.js';
import type { AgentRouteContext } from './agent-runs.js';

export function brokerPersistence(context: AgentRouteContext): ContextBrokerPersistence {
  return {
    enqueueWrite: (operation) => context.enqueueWrite(operation),
  };
}
