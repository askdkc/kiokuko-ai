import { createHash } from 'node:crypto';
import { KiokukoError } from '../errors.js';

export interface ManagedRegion<T> {
  readonly value: T;
  readonly digest: string;
}

export interface RebaseResult<T> {
  readonly content: string;
  readonly status: 'unchanged' | 'rebased' | 'conflict';
  readonly region: ManagedRegion<T>;
}

export type ManagedRegionReader<T> = (content: string) => ManagedRegion<T>;
export type ManagedRegionWriter<T> = (content: string, value: T) => string;

export function digestManagedRegion(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function rebaseManagedRegion<T>(
  base: string,
  latest: string,
  desired: T,
  read: ManagedRegionReader<T>,
  write: ManagedRegionWriter<T>,
): RebaseResult<T> {
  const baseRegion = read(base);
  const latestRegion = read(latest);
  const desiredContent = write(latest, desired);
  const desiredRegion = read(desiredContent);
  if (latestRegion.digest === desiredRegion.digest) {
    return { content: latest, status: 'unchanged', region: latestRegion };
  }
  if (latestRegion.digest !== baseRegion.digest) {
    throw new KiokukoError('CONFLICT', 'Managed file owned region changed concurrently', {
      reason: 'owned_region_conflict',
    });
  }
  return { content: desiredContent, status: 'rebased', region: desiredRegion };
}

export function managedRegionReader(
  content: string,
  start: number,
  end: number,
): ManagedRegion<string> {
  const value = content.slice(start, end);
  return { value, digest: digestManagedRegion(value) };
}
