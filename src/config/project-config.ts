import path from 'node:path';
import { types as utilTypes } from 'node:util';
import { KiokukoError } from '../errors.js';
import {
  validateRepositoryBindingIdentity,
  validateRepositoryId,
  validateWorkspace,
} from '../repository/identity-value.js';
import { readRegularFile } from '../agent-file/atomic-write.js';
import { assertStrictJsonSyntax } from '../setup/strict-json.js';

export interface ProjectConfig {
  schemaVersion: 1;
  repositoryId: string;
  workspace: string;
  agentFile: string;
  templateVersion: number;
}

// Binding validation is deliberately strict: unknown fields are rejected rather than ignored.
const REQUIRED_FIELD_NAMES = ['schemaVersion', 'repositoryId', 'workspace', 'agentFile', 'templateVersion'] as const;
const REQUIRED_FIELDS = new Set<string>(REQUIRED_FIELD_NAMES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotProjectConfig(value: Record<string, unknown>): Record<(typeof REQUIRED_FIELD_NAMES)[number], unknown> {
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== 'string' || !REQUIRED_FIELDS.has(field)) {
      throw new KiokukoError('VALIDATION_ERROR', `Unknown binding field: ${String(field)}`);
    }
  }
  const snapshot = {} as Record<(typeof REQUIRED_FIELD_NAMES)[number], unknown>;
  for (const field of REQUIRED_FIELD_NAMES) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new KiokukoError('VALIDATION_ERROR', `Binding field must be an enumerable data property: ${field}`);
    }
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function validateAgentFile(agentFile: unknown): asserts agentFile is string {
  if (typeof agentFile !== 'string'
    || agentFile.length === 0
    || agentFile.includes('\0')
    || /[\u0000-\u001f\u007f]/u.test(agentFile)) {
    throw new KiokukoError('VALIDATION_ERROR', 'agentFile must be a non-empty relative path');
  }
  const normalized = agentFile.replaceAll('\\', '/');
  const components = normalized.split('/');
  if (normalized !== agentFile
    || path.posix.isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || path.posix.normalize(normalized) !== normalized
    || components.some((component) => {
      const portableStem = component.split('.', 1)[0]?.replace(/[ .]+$/u, '').toUpperCase();
      return component === ''
        || component === '..'
        || component === '.'
        || component.includes(':')
        || /[ .]$/u.test(component)
        || portableStem === undefined
        || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/u.test(portableStem);
    })) {
    throw new KiokukoError('VALIDATION_ERROR', 'agentFile must remain inside the repository root');
  }
  const lower = normalized.toLowerCase();
  if (lower === '.kiokuko.json' || lower.startsWith('.kiokuko.json/')) {
    throw new KiokukoError('VALIDATION_ERROR', 'agentFile must not alias the repository binding file');
  }
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  if (!isPlainObject(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'binding must be a JSON object');
  }
  const snapshot = snapshotProjectConfig(value);
  if (snapshot.schemaVersion !== 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Unsupported binding schemaVersion');
  }
  validateRepositoryId(snapshot.repositoryId);
  validateWorkspace(snapshot.workspace);
  validateRepositoryBindingIdentity(snapshot.repositoryId, snapshot.workspace);
  validateAgentFile(snapshot.agentFile);
  const templateVersion = snapshot.templateVersion;
  if (typeof templateVersion !== 'number' || !Number.isSafeInteger(templateVersion) || templateVersion < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'templateVersion must be a positive safe integer');
  }
  return {
    schemaVersion: 1,
    repositoryId: snapshot.repositoryId,
    workspace: snapshot.workspace,
    agentFile: snapshot.agentFile,
    templateVersion,
  };
}

export function parseProjectConfigText(source: string): ProjectConfig {
  assertStrictJsonSyntax(
    source,
    { allowTrailingComma: false, disallowComments: true },
    'Project binding is not valid JSON with unique keys',
  );
  return parseProjectConfig(JSON.parse(source) as unknown);
}

export async function readProjectConfig(filePath: string): Promise<ProjectConfig> {
  const snapshot = await readRegularFile(filePath);
  if (snapshot === undefined) throw new KiokukoError('VALIDATION_ERROR', 'Project binding file is unavailable');
  return parseProjectConfigText(snapshot.content);
}
