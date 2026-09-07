import type { FileIdentity, RegularFileSnapshot } from '../agent-file/atomic-write.js';

export interface PhysicalIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface DocumentVersion {
  readonly contentDigest: string;
  readonly ownedRegionDigest: string | null;
}

export interface ManagedMutationGuard {
  readonly resourceKey: string;
  readonly token: symbol;
}

export type ManagedMutationOutcome =
  | { readonly status: 'not-written' | 'converged'; readonly snapshot?: RegularFileSnapshot; readonly owned: false }
  | { readonly status: 'committed'; readonly snapshot: RegularFileSnapshot; readonly owned: true };

export interface ManagedConflict {
  readonly reason: 'owned_region_conflict' | 'target_deleted' | 'binding_identity_conflict' | 'snapshot_changed';
  readonly path?: string;
}

export interface GuardedReplacement {
  readonly guard: ManagedMutationGuard;
  readonly target: string;
  readonly expected: RegularFileSnapshot | undefined;
  readonly parent: FileIdentity;
}
