import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { KiokukoError } from '../errors.js';

function cleanPath(value: string): string {
  return value.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
}

export function normalizeRemoteUrl(remoteUrl: string): string {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim().length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Git remote URL must be a non-empty string');
  }
  const raw = remoteUrl.trim();
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(raw);
  if (scp && !raw.includes('://')) {
    return `${scp[1]!.toLowerCase()}/${cleanPath(scp[2]!)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'Git remote URL is invalid');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(protocol)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Git remote URL scheme is unsupported');
  }
  const defaultPort = (protocol === 'https:' && parsed.port === '443') || (protocol === 'ssh:' && parsed.port === '22');
  const host = `${parsed.hostname.toLowerCase()}${parsed.port && !defaultPort ? `:${parsed.port}` : ''}`;
  return `${host}/${cleanPath(parsed.pathname)}`;
}

export function fingerprintRemoteUrl(remoteUrl: string): string {
  const normalized = normalizeRemoteUrl(remoteUrl);
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}
