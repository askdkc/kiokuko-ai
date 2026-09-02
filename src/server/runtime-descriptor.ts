import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KiokukoError } from '../errors.js';

export interface RuntimeDescriptor {
  protocolVersion: '1';
  instanceId: string;
  pid: number;
  baseUrl: string;
  databaseFingerprint: string;
  startedAt: string;
  capabilityToken: string;
}

export interface CreateRuntimeDescriptorInput {
  databasePath: string;
  baseUrl: string;
  pid?: number;
  instanceId?: string;
  startedAt?: string;
  capabilityToken?: string;
}

const DESCRIPTOR_FIELDS = new Set([
  'protocolVersion',
  'instanceId',
  'pid',
  'baseUrl',
  'databaseFingerprint',
  'startedAt',
  'capabilityToken',
]);

function validation(field: string): never {
  throw new KiokukoError('VALIDATION_ERROR', `Invalid runtime descriptor field: ${field}`);
}

function isLoopbackHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validateDescriptor(value: unknown): RuntimeDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Runtime descriptor must be an object');
  }
  for (const field of Object.keys(value)) {
    if (!DESCRIPTOR_FIELDS.has(field)) {
      throw new KiokukoError('VALIDATION_ERROR', `Unknown runtime descriptor field: ${field}`);
    }
  }
  const descriptor = value as Record<string, unknown>;
  for (const field of DESCRIPTOR_FIELDS) {
    if (!(field in descriptor)) validation(field);
  }
  if (descriptor.protocolVersion !== '1') validation('protocolVersion');
  if (typeof descriptor.instanceId !== 'string'
    || descriptor.instanceId.length === 0
    || descriptor.instanceId.length > 128
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(descriptor.instanceId)) {
    validation('instanceId');
  }
  if (typeof descriptor.pid !== 'number' || !Number.isInteger(descriptor.pid) || descriptor.pid <= 0) {
    validation('pid');
  }
  if (!isLoopbackHttpUrl(descriptor.baseUrl)) validation('baseUrl');
  if (typeof descriptor.databaseFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(descriptor.databaseFingerprint)) {
    validation('databaseFingerprint');
  }
  if (!isCanonicalUtc(descriptor.startedAt)) validation('startedAt');
  if (typeof descriptor.capabilityToken !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.capabilityToken)) {
    validation('capabilityToken');
  }
  return descriptor as unknown as RuntimeDescriptor;
}

export function createRuntimeDescriptor(input: CreateRuntimeDescriptorInput): RuntimeDescriptor {
  const databaseFingerprint = createHash('sha256')
    .update(path.resolve(input.databasePath), 'utf8')
    .digest('hex');
  return validateDescriptor({
    protocolVersion: '1',
    instanceId: input.instanceId ?? randomUUID(),
    pid: input.pid ?? process.pid,
    baseUrl: input.baseUrl,
    databaseFingerprint: `sha256:${databaseFingerprint}`,
    startedAt: input.startedAt ?? new Date().toISOString(),
    capabilityToken: input.capabilityToken ?? randomBytes(32).toString('hex'),
  });
}

export type RuntimeDescriptorView = Omit<RuntimeDescriptor, 'capabilityToken'>;

export function toPublicRuntimeDescriptor(descriptor: RuntimeDescriptor): RuntimeDescriptorView {
  return {
    protocolVersion: descriptor.protocolVersion,
    instanceId: descriptor.instanceId,
    pid: descriptor.pid,
    baseUrl: descriptor.baseUrl,
    databaseFingerprint: descriptor.databaseFingerprint,
    startedAt: descriptor.startedAt,
  };
}

export async function writeRuntimeDescriptor(filePath: string, descriptor: RuntimeDescriptor): Promise<void> {
  validateDescriptor(descriptor);
  try {
    assertSecureDescriptorFile(await lstat(filePath));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error;
    }
  }
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(descriptor)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function assertSecureDescriptorFile(info: Awaited<ReturnType<typeof lstat>>): void {
  if (info.isSymbolicLink()) {
    throw new KiokukoError('SECURITY_REJECTION', 'Runtime descriptor must not be a symbolic link');
  }
  if (!info.isFile()) {
    throw new KiokukoError('VALIDATION_ERROR', 'Runtime descriptor must be a regular file');
  }
  if (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0) {
    throw new KiokukoError('SECURITY_REJECTION', 'Runtime descriptor permissions are too broad');
  }
}

export async function readRuntimeDescriptor(filePath: string): Promise<RuntimeDescriptor | undefined> {
  try {
    assertSecureDescriptorFile(await lstat(filePath));
    return validateDescriptor(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new KiokukoError('VALIDATION_ERROR', 'Runtime descriptor JSON is invalid');
    }
    throw error;
  }
}

export async function removeRuntimeDescriptor(filePath: string, expectedInstanceId: string): Promise<boolean> {
  const descriptor = await readRuntimeDescriptor(filePath);
  if (!descriptor || descriptor.instanceId !== expectedInstanceId) return false;
  await unlink(filePath);
  return true;
}
