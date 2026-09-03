import { KiokukoError } from '../errors.js';

class SetupOpenCodeMcpIdentityConflictError extends KiokukoError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

export function setupOpenCodeMcpIdentityConflict(message: string): never {
  throw new SetupOpenCodeMcpIdentityConflictError(message);
}

export function isSetupOpenCodeMcpIdentityConflict(error: unknown): boolean {
  return error instanceof SetupOpenCodeMcpIdentityConflictError;
}
