import { KiokukoError } from '../errors.js';

const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RESERVED_GLOBAL_REPOSITORY_ID = 'kiokuko_global';
const RESERVED_GLOBAL_WORKSPACE = 'global';

function validateCanonicalIdentity(
  value: unknown,
  label: 'repositoryId' | 'workspace',
  pattern: RegExp,
): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      `${label} must use the canonical ASCII identity grammar`,
    );
  }
}

export function validateRepositoryId(value: unknown): asserts value is string {
  validateCanonicalIdentity(value, 'repositoryId', REPOSITORY_ID_PATTERN);
}

export function validateWorkspace(value: unknown): asserts value is string {
  validateCanonicalIdentity(value, 'workspace', WORKSPACE_PATTERN);
}

export function validateRepositoryBindingIdentity(repositoryId: unknown, workspace: unknown): void {
  validateRepositoryId(repositoryId);
  validateWorkspace(workspace);
  if (repositoryId === RESERVED_GLOBAL_REPOSITORY_ID || workspace === RESERVED_GLOBAL_WORKSPACE) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'Reserved global identities cannot be used for a project repository binding',
    );
  }
}
