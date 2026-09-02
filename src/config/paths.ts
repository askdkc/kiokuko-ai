import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { KiokukoError } from '../errors.js';

export interface PathEnvironment {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function selectedEnvironment({ platform = process.platform, env = process.env }: PathEnvironment): {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
} {
  return { platform, env };
}

function configuredDataDirectory(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.KIOKUKO_DATA_DIR;
  if (configured === undefined) return undefined;

  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (
    configured.length === 0
    || configured.length > 4096
    || configured !== configured.trim()
    || configured.includes('\0')
    || !platformPath.isAbsolute(configured)
  ) {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_DATA_DIR must be a bounded absolute path');
  }
  const normalized = platformPath.normalize(configured);
  if (normalized === platformPath.parse(normalized).root) {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_DATA_DIR must not be a filesystem root');
  }
  return normalized;
}

export function getPlatformDataDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const configured = configuredDataDirectory(platform, env);
  if (configured !== undefined) return configured;

  if (platform === 'win32') {
    const root = env.LOCALAPPDATA ?? env.APPDATA ?? env.USERPROFILE;
    if (!root) {
      throw new KiokukoError('VALIDATION_ERROR', 'A Windows user data directory is unavailable');
    }
    return join(root, 'kiokuko');
  }

  if (platform === 'darwin') {
    const home = env.HOME;
    if (!home) throw new KiokukoError('VALIDATION_ERROR', 'HOME is unavailable');
    return join(home, 'Library', 'Application Support', 'kiokuko');
  }

  const root = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : undefined);
  if (!root) throw new KiokukoError('VALIDATION_ERROR', 'XDG_DATA_HOME or HOME is unavailable');
  return join(root, 'kiokuko');
}

export function getRuntimeDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const configured = configuredDataDirectory(platform, env);
  if (configured !== undefined) return configured;

  if (platform === 'linux' && env.XDG_RUNTIME_DIR) {
    return join(env.XDG_RUNTIME_DIR, 'kiokuko');
  }

  return getPlatformDataDirectory(options);
}

export function getRuntimeDescriptorPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getRuntimeDirectory(options), 'server.json');
}

export function getDatabaseLockPath(databasePath: string, options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const resolvedPath = platformPath.resolve(databasePath);
  const fingerprint = createHash('sha256').update(resolvedPath, 'utf8').digest('hex');
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getRuntimeDirectory(options), `${fingerprint}.lock`);
}

export function getGlobalDatabasePath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getPlatformDataDirectory(options), 'kiokuko-ai.sqlite');
}

function requireHome(options: PathEnvironment): { home: string; join: typeof path.posix.join } {
  const { platform, env } = selectedEnvironment(options);
  const home = platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : env.HOME;
  if (!home) throw new KiokukoError('VALIDATION_ERROR', 'The user home directory is unavailable');
  return { home, join: platform === 'win32' ? path.win32.join : path.posix.join };
}

/** OpenCode's documented global configuration directory. */
export function getOpenCodeConfigDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'opencode');
  const { home } = requireHome(options);
  return join(home, '.config', 'opencode');
}

export function getOpenCodeInstructionsPath(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getOpenCodeConfigDirectory(options), 'AGENTS.md');
}

export function getOpenCodeSkillsDirectory(options: PathEnvironment = {}): string {
  const { platform } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getOpenCodeConfigDirectory(options), 'skills');
}

export async function ensurePlatformDataDirectory(options: PathEnvironment = {}): Promise<string> {
  const directory = getPlatformDataDirectory(options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function embeddingCoordinate(value: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value) && field === 'preset') {
    throw new KiokukoError('VALIDATION_ERROR', `${field} is invalid`);
  }
  if (field === 'revision' && !/^[0-9a-f]{40}$/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', `${field} is invalid`);
  }
  return value;
}

export function getEmbeddingModelsDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getPlatformDataDirectory({ platform, env }), 'models', 'embeddings');
}

export function getEmbeddingModelStagingDirectory(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getEmbeddingModelsDirectory({ platform, env }), '.staging');
}

export function getEmbeddingSetupLockPath(options: PathEnvironment = {}): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getEmbeddingModelsDirectory({ platform, env }), '.setup.lock');
}

export function getEmbeddingPresetDirectory(
  preset: string,
  revision: string,
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(
    getEmbeddingModelsDirectory({ platform, env }),
    embeddingCoordinate(preset, 'preset'),
    embeddingCoordinate(revision, 'revision'),
  );
}

export function getEmbeddingModelManifestPath(
  preset: string,
  revision: string,
  options: PathEnvironment = {},
): string {
  const { platform, env } = selectedEnvironment(options);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(getEmbeddingPresetDirectory(preset, revision, { platform, env }), 'kiokuko-model-manifest.json');
}
