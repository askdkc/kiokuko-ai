import { getRuntimeDescriptorPath } from '../config/paths.js';
import { KiokukoError } from '../errors.js';
import {
  isPidAlive,
  type PidLiveness,
} from '../server/instance-lock.js';
import {
  readRuntimeDescriptor,
  toPublicRuntimeDescriptor,
  type RuntimeDescriptorView,
} from '../server/runtime-descriptor.js';

export type ServerStatus =
  | { running: false; stale: false }
  | { running: true; stale: false; descriptor: RuntimeDescriptorView }
  | { running: false; stale: true; descriptor: RuntimeDescriptorView };

export interface ServerStatusOptions {
  descriptorPath?: string;
  isPidAlive?: PidLiveness;
}

export async function getServerStatus(options: ServerStatusOptions = {}): Promise<ServerStatus> {
  const descriptor = await readRuntimeDescriptor(options.descriptorPath ?? getRuntimeDescriptorPath());
  if (!descriptor) return { running: false, stale: false };

  let alive: boolean;
  try {
    alive = await (options.isPidAlive ?? isPidAlive)(descriptor.pid);
  } catch {
    throw new KiokukoError('SERVICE_UNAVAILABLE', 'Unable to determine server process liveness');
  }

  const publicDescriptor = toPublicRuntimeDescriptor(descriptor);
  if (!alive) return { running: false, stale: true, descriptor: publicDescriptor };
  return { running: true, stale: false, descriptor: publicDescriptor };
}
