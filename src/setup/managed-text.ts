import { KiokukoError } from '../errors.js';

export interface DelimitedBlockResult {
  content: string;
  action: 'created' | 'updated' | 'unchanged';
}

function positions(content: string, marker: string): number[] {
  const found: number[] = [];
  let offset = 0;
  for (;;) {
    const position = content.indexOf(marker, offset);
    if (position < 0) return found;
    found.push(position);
    offset = position + marker.length;
  }
}

function isStandaloneMarker(content: string, marker: string, position: number): boolean {
  const before = position === 0 ? '' : content[position - 1];
  const after = content.slice(position + marker.length, position + marker.length + 2);
  return (position === 0 || before === '\n')
    && (position + marker.length === content.length || after.startsWith('\n') || after === '\r\n');
}

function eolFor(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export function upsertDelimitedBlock(
  existing: string,
  block: string,
  beginMarker: string,
  endMarker: string,
  label: string,
): DelimitedBlockResult {
  const begins = positions(existing, beginMarker);
  const ends = positions(existing, endMarker);
  if ((begins.length === 0) !== (ends.length === 0)
    || begins.length > 1
    || ends.length > 1
    || (begins[0] !== undefined && !isStandaloneMarker(existing, beginMarker, begins[0]))
    || (ends[0] !== undefined && !isStandaloneMarker(existing, endMarker, ends[0]))) {
    throw new KiokukoError('VALIDATION_ERROR', `${label} contains malformed Kiokuko managed markers`);
  }
  const eol = eolFor(existing);
  const normalized = block.replaceAll('\r\n', '\n').replaceAll('\n', eol);
  if (begins.length === 0) {
    if (existing.length === 0) return { content: `${normalized}${eol}`, action: 'created' };
    const separator = existing.endsWith('\n') || existing.endsWith('\r') ? eol : `${eol}${eol}`;
    return { content: `${existing}${separator}${normalized}${eol}`, action: 'created' };
  }
  const begin = begins[0]!;
  const end = ends[0]!;
  if (begin >= end) throw new KiokukoError('VALIDATION_ERROR', `${label} contains malformed Kiokuko managed markers`);
  const endExclusive = end + endMarker.length;
  if (existing.slice(begin, endExclusive) === normalized) return { content: existing, action: 'unchanged' };
  return {
    content: `${existing.slice(0, begin)}${normalized}${existing.slice(endExclusive)}`,
    action: 'updated',
  };
}
