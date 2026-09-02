import { lstat, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as z from 'zod/v4';
import { PACKAGE_VERSION } from '../package-version.js';
import { OPENCODE_HOOK_PROTOCOL_VERSION } from './hook-protocol.js';
import type { OpenCodeRuntimeInvocation } from './hook-effect.js';

const absolutePath = z.string()
  .min(1)
  .max(4_096)
  .refine((value) => path.isAbsolute(value))
  .refine((value) => !value.includes('\0'));

const pluginOptionsSchema = z.object({
  protocolVersion: z.literal(OPENCODE_HOOK_PROTOCOL_VERSION),
  packageVersion: z.string().min(1).max(100),
  nodeExecutable: absolutePath,
  cliScript: absolutePath,
}).strict();

export type OpenCodePluginOptions = z.infer<typeof pluginOptionsSchema>;

export function parseOpenCodePluginOptions(value: unknown): OpenCodePluginOptions | undefined {
  const parsed = pluginOptionsSchema.safeParse(value);
  if (!parsed.success || parsed.data.packageVersion !== PACKAGE_VERSION) return undefined;
  return parsed.data;
}

async function regularFile(filePath: string): Promise<boolean> {
  try {
    const status = await lstat(filePath);
    return status.isFile() && !status.isSymbolicLink()
      && (process.platform === 'win32' || (status.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

async function packageOwnedCli(): Promise<string | undefined> {
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/kiokuko.js'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/bin/kiokuko.js'),
  ];
  for (const candidate of candidates) {
    if (await regularFile(candidate)) return candidate;
  }
  return undefined;
}

async function configuredCli(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const configured = env.KIOKUKO_CLI_SCRIPT;
  if (
    configured === undefined
    || configured.trim() !== configured
    || configured.length === 0
    || !path.isAbsolute(configured)
    || /[\u0000-\u001f\u007f\u200b\u200c\u200d\u2060\ufeff\u202a-\u202e]/u.test(configured)
  ) return undefined;
  return await regularFile(configured) ? configured : undefined;
}

async function cliCandidates(env: NodeJS.ProcessEnv): Promise<string[]> {
  const candidates: string[] = [];
  const configured = await configuredCli(env);
  if (configured !== undefined) candidates.push(configured);
  const argvScript = process.argv[1];
  if (
    argvScript !== undefined
    && path.isAbsolute(argvScript)
    && await regularFile(argvScript)
    && !candidates.includes(argvScript)
  ) candidates.push(argvScript);
  const owned = await packageOwnedCli();
  if (owned !== undefined && !candidates.includes(owned)) candidates.push(owned);
  return candidates;
}

async function readAdjacentPackage(cliScript: string): Promise<{ name?: unknown; version?: unknown } | undefined> {
  const packagePath = path.resolve(path.dirname(cliScript), '..', '..', 'package.json');
  try {
    return JSON.parse(await readFile(packagePath, 'utf8')) as { name?: unknown; version?: unknown };
  } catch {
    return undefined;
  }
}

/** Resolve the package-owned Node and CLI pair used by setup-generated config. */
export async function resolveManagedOpenCodeRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenCodeRuntimeInvocation | undefined> {
  if (!await regularFile(process.execPath)) return undefined;
  let nodeExecutable: string;
  try {
    nodeExecutable = await realpath(process.execPath);
  } catch {
    return undefined;
  }
  if (!await regularFile(nodeExecutable)) return undefined;
  for (const cliScript of await cliCandidates(env)) {
    let resolvedCliScript: string;
    try {
      resolvedCliScript = await realpath(cliScript);
    } catch {
      continue;
    }
    if (!await regularFile(resolvedCliScript)) continue;
    const metadata = await readAdjacentPackage(resolvedCliScript);
    if (metadata?.name !== 'kiokuko-ai' || metadata.version !== PACKAGE_VERSION) continue;
    return {
      protocolVersion: OPENCODE_HOOK_PROTOCOL_VERSION,
      packageVersion: PACKAGE_VERSION,
      nodeExecutable,
      cliScript: resolvedCliScript,
    };
  }
  return undefined;
}
