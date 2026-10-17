interface HostMessage {
  role: string;
  tool_call_id?: string;
  content?: unknown;
}

interface HostProviderRequest {
  tools?: Array<{
    name?: string;
    function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
    input_schema?: { properties?: Record<string, unknown> };
  }>;
  messages?: HostMessage[];
}

type HostProviderReply = { text: string } | {
  toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};

interface HostSessionClient {
  session: {
    create(input: {
      location: { directory: string };
      model: { providerID: string; id: string };
      permissions: Array<{ action: string; resource: string; effect: string }>;
    }): Promise<{ id: string }>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<unknown>;
    context(input: { sessionID: string }): Promise<Array<{
      type: string;
      time: { completed?: number };
      content?: Array<{ type: string }>;
    }>>;
    interrupt(input: { sessionID: string }): Promise<unknown>;
    command(input: { sessionID: string; name: string; text: string }): Promise<unknown>;
  };
}

export function lispHostProbe(): {
  respond(body: HostProviderRequest): HostProviderReply | undefined;
  run(client: HostSessionClient, location: { directory: string }): Promise<unknown>;
};
