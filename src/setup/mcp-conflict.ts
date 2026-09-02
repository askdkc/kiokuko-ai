import { KiokukoError } from '../errors.js';

export type SetupMcpClient = 'opencode';

class SetupMcpIdentityConflictError extends KiokukoError {
  constructor(
    readonly client: SetupMcpClient,
    message: string,
  ) {
    super('CONFLICT', message);
  }
}

export function setupMcpIdentityConflict(client: SetupMcpClient, message: string): never {
  throw new SetupMcpIdentityConflictError(client, message);
}

export function setupMcpIdentityConflictClient(error: unknown): SetupMcpClient | undefined {
  return error instanceof SetupMcpIdentityConflictError ? error.client : undefined;
}
