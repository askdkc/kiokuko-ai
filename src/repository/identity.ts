import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fingerprintRemoteUrl } from './remote-url.js';
import { validateRepositoryBindingIdentity } from './identity-value.js';

export interface ExistingBindingIdentity {
  repositoryId: string;
  workspace: string;
}

export interface RepositoryIdentityOptions {
  repositoryRoot: string;
  remoteUrl?: string;
  repositoryId?: string;
  workspace?: string;
  existingBinding?: ExistingBindingIdentity;
}

export interface RepositoryIdentity {
  repositoryId: string;
  workspace: string;
  displayName: string;
  remoteFingerprint: string | null;
}

function slugForRoot(repositoryRoot: string): string {
  const base = path.basename(repositoryRoot) || 'repository';
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
}

function shortIdentityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function createRepositoryIdentity(options: RepositoryIdentityOptions): RepositoryIdentity {
  const displayName = slugForRoot(options.repositoryRoot);
  const remoteFingerprint = options.remoteUrl ? fingerprintRemoteUrl(options.remoteUrl) : null;
  const remoteHash = remoteFingerprint?.slice('sha256:'.length);
  const repositoryId = options.existingBinding?.repositoryId
    ?? options.repositoryId
    ?? (remoteHash ? `repo_${remoteHash.slice(0, 12)}` : `repo_${randomUUID()}`);
  const workspace = options.existingBinding?.workspace
    ?? options.workspace
    ?? `project:${displayName}-${shortIdentityHash(repositoryId)}`;
  validateRepositoryBindingIdentity(repositoryId, workspace);
  return { repositoryId, workspace, displayName, remoteFingerprint };
}
