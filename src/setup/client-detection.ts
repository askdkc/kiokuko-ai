import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PathEnvironment } from '../config/paths.js';

export const DETECTABLE_CLIENTS = ['opencode'] as const;
export type DetectableClient = (typeof DETECTABLE_CLIENTS)[number];

export interface ClientDetectionDependencies {
  stat?: typeof stat;
  access?: typeof access;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function hasExecutable(
  platform: NodeJS.Platform,
  pathModule: typeof path.posix,
  env: NodeJS.ProcessEnv,
  executableBaseName: string,
  dependencies: Required<ClientDetectionDependencies>,
): Promise<boolean> {
  const pathValue = env.PATH;
  if (!pathValue) return false;
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const executableNames = platform === 'win32'
    ? [`${executableBaseName}.exe`, `${executableBaseName}.cmd`, `${executableBaseName}.bat`, executableBaseName]
    : [executableBaseName];

  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const executableName of executableNames) {
      const executable = pathModule.join(directory, executableName);
      try {
        const info = await dependencies.stat(executable);
        if (!info.isFile()) continue;
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) continue;
        throw error;
      }
      try {
        await dependencies.access(executable, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch (error) {
        if (['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) continue;
        throw error;
      }
    }
  }
  return false;
}

/** Detect supported client executables without mutating client state. */
export async function detectInstalledClients(
  options: PathEnvironment = {},
  dependencyOverrides: ClientDetectionDependencies = {},
): Promise<DetectableClient[]> {
  const platform = options.platform ?? process.platform;
  const pathModule = platform === 'win32' ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const dependencies: Required<ClientDetectionDependencies> = {
    stat: dependencyOverrides.stat ?? stat,
    access: dependencyOverrides.access ?? access,
  };
  const installed: DetectableClient[] = [];
  for (const client of DETECTABLE_CLIENTS) {
    if (await hasExecutable(platform, pathModule, env, client, dependencies)) installed.push(client);
  }
  return installed;
}
