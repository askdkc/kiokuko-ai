import { KiokukoError } from '../errors.js';

export const BEGIN_MARKER = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->';
export const END_MARKER = '<!-- END KIOKUKO MANAGED BLOCK -->';

type ManagedBlockState = 'absent' | 'balanced';

export interface ManagedBlockResult {
  content: string;
  action: 'created' | 'updated' | 'unchanged';
  state: ManagedBlockState;
}

export interface ManagedBlockRemovalResult {
  content: string | undefined;
  action: 'absent' | 'updated' | 'deleted';
}

function markerPositions(content: string, marker: string): number[] {
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const index = content.indexOf(marker, from);
    if (index < 0) return positions;
    positions.push(index);
    from = index + marker.length;
  }
}

function isStandaloneMarker(content: string, marker: string, position: number): boolean {
  const before = position === 0 ? '' : content[position - 1];
  const after = content.slice(position + marker.length, position + marker.length + 2);
  return (position === 0 || before === '\n')
    && (position + marker.length === content.length || after.startsWith('\n') || after === '\r\n');
}

function validateMarkers(content: string): { start: number; end: number } | undefined {
  const starts = markerPositions(content, BEGIN_MARKER);
  const ends = markerPositions(content, END_MARKER);
  if (starts.length === 0 && ends.length === 0) return undefined;
  const start = starts[0];
  const end = ends[0];
  if (starts.length !== 1
    || ends.length !== 1
    || start === undefined
    || end === undefined
    || start >= end
    || !isStandaloneMarker(content, BEGIN_MARKER, start)
    || !isStandaloneMarker(content, END_MARKER, end)) {
    throw new KiokukoError('VALIDATION_ERROR', 'AGENTS.md contains malformed Kiokuko managed markers');
  }
  return { start, end: end + END_MARKER.length };
}

function newlineFor(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeBlock(block: string, newline: string): string {
  return block.replaceAll('\r\n', '\n').replaceAll('\n', newline);
}

export function upsertManagedBlock(existing: string, managedBlock: string): ManagedBlockResult {
  const markers = validateMarkers(existing);
  const newline = newlineFor(existing);
  const normalizedBlock = normalizeBlock(managedBlock, newline);
  if (!markers) {
    if (existing.length === 0) return { content: normalizedBlock, action: 'created', state: 'absent' };
    const separator = existing.endsWith('\n') || existing.endsWith('\r') ? `${newline}${newline}` : `${newline}${newline}${newline}`;
    return { content: `${existing}${separator}${normalizedBlock}`, action: 'created', state: 'absent' };
  }
  const currentBlock = existing.slice(markers.start, markers.end);
  if (currentBlock === normalizedBlock) return { content: existing, action: 'unchanged', state: 'balanced' };
  return {
    content: `${existing.slice(0, markers.start)}${normalizedBlock}${existing.slice(markers.end)}`,
    action: 'updated',
    state: 'balanced',
  };
}

/**
 * Remove only the exact marked region. Bytes outside the markers are owned by
 * the user and are never normalized or trimmed. A file is deletable only when
 * the managed block occupied the entire file.
 */
export function removeManagedBlock(existing: string): ManagedBlockRemovalResult {
  const markers = validateMarkers(existing);
  if (markers === undefined) return { content: existing, action: 'absent' };
  const content = `${existing.slice(0, markers.start)}${existing.slice(markers.end)}`;
  return content.length === 0
    ? { content: undefined, action: 'deleted' }
    : { content, action: 'updated' };
}

/** Return the canonical template declaration from one validated managed block. */
export function readManagedBlockTemplateVersion(existing: string): number | undefined {
  const markers = validateMarkers(existing);
  if (markers === undefined) return undefined;
  const lines = existing
    .slice(markers.start, markers.end)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter((line) => line.includes('kiokuko-template-version'));
  if (lines.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Managed block is missing its template-version declaration');
  }
  if (lines.length !== 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Managed block has ambiguous template-version declarations');
  }
  const match = /^<!-- kiokuko-template-version: ([1-9][0-9]*) -->$/u.exec(lines[0] ?? '');
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Managed block has a malformed template-version declaration');
  }
  return version;
}
