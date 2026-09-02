import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { PACKAGE_VERSION } from '../package-version.js';
import { isSkillDiscoveryMode, SKILL_DISCOVERY_ENV } from '../skills/config.js';
import type { SkillDiscoveryMode } from '../skills/types.js';
import type { DelimitedBlockResult } from './managed-text.js';
import { setupMcpIdentityConflict, setupMcpIdentityConflictClient } from './mcp-conflict.js';
import { assertStrictJsonSyntax } from './strict-json.js';
import type { OpenCodeRuntimeInvocation } from '../opencode/hook-effect.js';

export const KIOKUKO_OPENCODE_PLUGIN_PACKAGE = 'kiokuko-ai';
/** @deprecated Use KIOKUKO_OPENCODE_PLUGIN_PACKAGE. */
export const KIOKUKO_OPENCODE_PLUGIN = KIOKUKO_OPENCODE_PLUGIN_PACKAGE;

export function managedOpenCodePluginSpecifier(version = PACKAGE_VERSION): string {
  if (typeof version !== 'string' || version.trim().length === 0 || version.includes('\0')) {
    throw new KiokukoError('VALIDATION_ERROR', 'OpenCode plugin version is invalid');
  }
  return `${KIOKUKO_OPENCODE_PLUGIN_PACKAGE}@${version}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isNonEmptyCommand(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim() === value && !value.includes('\0');
}

function pluginSpecifier(value: unknown): string | undefined {
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
}

function pluginPackage(value: unknown): string | undefined {
  const candidate = pluginSpecifier(value);
  if (candidate === undefined || candidate.trim().length === 0 || candidate.includes('\0')) return undefined;
  const versionSeparator = candidate.startsWith('@')
    ? candidate.indexOf('@', candidate.indexOf('/') + 1)
    : candidate.indexOf('@');
  return versionSeparator === -1 ? candidate : candidate.slice(0, versionSeparator);
}

function pluginVersion(value: unknown): string | undefined {
  const candidate = pluginSpecifier(value);
  if (candidate === undefined) return undefined;
  const packageName = pluginPackage(value);
  if (packageName === undefined || candidate === packageName) return undefined;
  return candidate.slice(packageName.length + 1);
}

function validatePluginEntries(root: Record<string, unknown>): unknown[] {
  if (root.plugin === undefined) return [];
  if (!Array.isArray(root.plugin)) validation('OpenCode config plugin must be an array');
  const entries = root.plugin as unknown[];
  const managed = entries.filter((entry) => pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE);
  if (managed.length > 1) conflict();
  for (const entry of entries) {
    if (pluginPackage(entry) === undefined) validation('OpenCode config plugin entries must be package names or package tuples');
    if (pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE && Array.isArray(entry)
      && entry.length > 1 && object(entry[1]) === undefined) {
      conflict();
    }
  }
  return entries;
}

function validEnvironment(value: unknown): value is Record<string, unknown> {
  const environment = object(value);
  return environment !== undefined
    && hasExactKeys(environment, [SKILL_DISCOVERY_ENV])
    && isSkillDiscoveryMode(environment[SKILL_DISCOVERY_ENV]);
}

function isLegacyExecutable(value: string): boolean {
  return value === KIOKUKO_OPENCODE_PLUGIN_PACKAGE
    || value === 'kiokuko'
    || path.basename(value).toLowerCase() === 'kiokuko.js';
}

function isCanonicalManagedServer(value: unknown, runtime?: OpenCodeRuntimeInvocation): value is Record<string, unknown> {
  const server = object(value);
  if (server === undefined || !hasExactKeys(server, ['type', 'command', 'enabled', 'environment'])) return false;
  if (server.type !== 'local' || server.enabled !== true || !validEnvironment(server.environment)) return false;
  if (!Array.isArray(server.command) || server.command.length !== (runtime === undefined ? 2 : 3)) return false;
  if (runtime === undefined) {
    return isNonEmptyCommand(server.command[0]) && server.command[1] === 'mcp';
  }
  return server.command[0] === runtime.nodeExecutable
    && server.command[1] === runtime.cliScript
    && server.command[2] === 'mcp';
}

function isLegacyManagedServer(value: unknown): boolean {
  const server = object(value);
  if (server === undefined || !hasExactKeys(server, ['type', 'command', 'enabled', 'environment'])) return false;
  if (server.type !== 'local' || server.enabled !== true || !validEnvironment(server.environment)) return false;
  return Array.isArray(server.command)
    && server.command.length === 2
    && isNonEmptyCommand(server.command[0])
    && server.command[1] === 'mcp'
    && isLegacyExecutable(server.command[0]);
}

function managedPluginOptions(runtime: OpenCodeRuntimeInvocation): Record<string, unknown> {
  return {
    protocolVersion: runtime.protocolVersion,
    packageVersion: runtime.packageVersion,
    nodeExecutable: runtime.nodeExecutable,
    cliScript: runtime.cliScript,
  };
}

function updatedPluginEntry(entry: unknown, runtime?: OpenCodeRuntimeInvocation): unknown {
  const specifier = managedOpenCodePluginSpecifier(runtime?.packageVersion ?? PACKAGE_VERSION);
  if (runtime === undefined) return Array.isArray(entry) && entry.length > 1 ? [specifier, entry[1]] : specifier;
  if (!Array.isArray(entry)) return [specifier, managedPluginOptions(runtime)];
  const existingOptions = object(entry[1]) ?? {};
  return [specifier, { ...existingOptions, ...managedPluginOptions(runtime) }];
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function conflict(): never {
  setupMcpIdentityConflict('opencode', 'OpenCode config already contains a conflicting kiokuko MCP server');
}

export type OpenCodeIntegrationStatus = 'absent' | 'current' | 'legacy' | 'outdated' | 'duplicate' | 'conflict';

export interface OpenCodeIntegrationInspection {
  plugin: OpenCodeIntegrationStatus;
  mcp: Exclude<OpenCodeIntegrationStatus, 'duplicate'>;
}

function parseOpenCodeRoot(existing: string): Record<string, unknown> {
  assertStrictJsonSyntax(
    existing,
    { allowTrailingComma: true, disallowComments: false },
    'OpenCode config is not a valid JSON/JSONC object with unique keys',
  );
  const errors: ParseError[] = [];
  const parsed = parse(existing, errors, { allowTrailingComma: true, disallowComments: false });
  const root = object(parsed);
  if (errors.length > 0 || root === undefined) validation('OpenCode config is not a valid JSON/JSONC object');
  return root;
}

/** Inspect managed OpenCode identities without rendering or mutating config. */
export function inspectOpenCodeIntegration(
  existing: string | undefined,
  runtime?: OpenCodeRuntimeInvocation,
): OpenCodeIntegrationInspection {
  if (existing === undefined) return { plugin: 'absent', mcp: 'absent' };
  const root = parseOpenCodeRoot(existing);
  let plugins: unknown[];
  try {
    plugins = validatePluginEntries(root);
  } catch (error) {
    if (setupMcpIdentityConflictClient(error) === 'opencode') return { plugin: 'conflict', mcp: 'conflict' };
    throw error;
  }
  const managedPlugins = plugins.filter((entry) => pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE);
  let plugin: OpenCodeIntegrationStatus = managedPlugins.length === 0 ? 'absent' : 'current';
  if (managedPlugins.length > 1) plugin = 'duplicate';
  else if (managedPlugins[0] !== undefined) {
    const entry = managedPlugins[0];
    if (runtime !== undefined) {
      const options = Array.isArray(entry) ? object(entry[1]) : undefined;
      plugin = pluginSpecifier(entry) === managedOpenCodePluginSpecifier(runtime.packageVersion)
        && options?.protocolVersion === runtime.protocolVersion
        && options.packageVersion === runtime.packageVersion
        && options.nodeExecutable === runtime.nodeExecutable
        && options.cliScript === runtime.cliScript
        ? 'current'
        : pluginVersion(entry) === undefined ? 'legacy' : 'outdated';
    } else {
      plugin = pluginVersion(entry) === PACKAGE_VERSION ? 'current' : pluginVersion(entry) === undefined ? 'legacy' : 'outdated';
    }
  }
  const mcpRoot = object(root.mcp);
  if (root.mcp !== undefined && mcpRoot === undefined) return { plugin, mcp: 'conflict' };
  const server = mcpRoot?.kiokuko;
  if (server === undefined) return { plugin, mcp: 'absent' };
  if (runtime !== undefined && isCanonicalManagedServer(server, runtime)) return { plugin, mcp: 'current' };
  if (runtime === undefined && isCanonicalManagedServer(server)) return { plugin, mcp: 'current' };
  if (isLegacyManagedServer(server)) return { plugin, mcp: 'legacy' };
  return { plugin, mcp: 'conflict' };
}

/** Detect an already managed OpenCode Kiokuko MCP identity without changing it. */
export function hasCanonicalOpenCodeMcpConfig(
  existing: string | undefined,
  runtime?: OpenCodeRuntimeInvocation,
): boolean {
  if (existing === undefined) return false;
  const inspection = inspectOpenCodeIntegration(existing, runtime);
  return inspection.mcp === 'current';
}

export function renderOpenCodeConfig(
  existing: string | undefined,
  command = KIOKUKO_OPENCODE_PLUGIN_PACKAGE,
  skillDiscoveryMode?: SkillDiscoveryMode,
  options: { replaceConflictingIdentity?: boolean; runtime?: OpenCodeRuntimeInvocation } = {},
): DelimitedBlockResult {
  if (!isNonEmptyCommand(command)) validation('OpenCode MCP command must be a non-empty executable path or name');
  if (skillDiscoveryMode !== undefined && !isSkillDiscoveryMode(skillDiscoveryMode)) {
    validation('OpenCode Skill discovery mode is invalid');
  }
  if (options.replaceConflictingIdentity !== undefined && typeof options.replaceConflictingIdentity !== 'boolean') {
    validation('OpenCode MCP replacement authorization is invalid');
  }
  const source = existing ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const root = parseOpenCodeRoot(source);
  const plugins = validatePluginEntries(root);
  const mcp = object(root.mcp);
  if (root.mcp !== undefined && mcp === undefined) validation('OpenCode config has an invalid mcp object');
  const currentServer = mcp?.kiokuko;
  const runtime = options.runtime;
  const canonicalServer = currentServer !== undefined && (runtime === undefined
    ? isCanonicalManagedServer(currentServer)
    : isCanonicalManagedServer(currentServer, runtime)) ? currentServer : undefined;
  const legacyServer = runtime !== undefined && currentServer !== undefined && isLegacyManagedServer(currentServer);
  if (currentServer !== undefined && canonicalServer === undefined && !legacyServer && !options.replaceConflictingIdentity) conflict();
  const currentEnvironment = object(object(canonicalServer)?.environment)
    ?? object(legacyServer ? object(currentServer)?.environment : undefined);
  const effectiveSkillDiscoveryMode = skillDiscoveryMode
    ?? (currentEnvironment?.[SKILL_DISCOVERY_ENV] as SkillDiscoveryMode | undefined)
    ?? 'official';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const mcpCommand = runtime === undefined
    ? [command, 'mcp']
    : [runtime.nodeExecutable, runtime.cliScript, 'mcp'];
  const edits = modify(source, ['mcp', 'kiokuko'], {
    type: 'local',
    command: mcpCommand,
    enabled: true,
    environment: { [SKILL_DISCOVERY_ENV]: effectiveSkillDiscoveryMode },
  }, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } });
  let content = applyEdits(source, edits);
  const managedIndex = plugins.findIndex((entry) => pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE);
  const desiredPlugin = updatedPluginEntry(managedIndex === -1 ? undefined : plugins[managedIndex], runtime);
  if (managedIndex === -1) {
    content = applyEdits(content, modify(content, ['plugin'], [...plugins, desiredPlugin], {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    }));
  } else if (JSON.stringify(plugins[managedIndex]) !== JSON.stringify(desiredPlugin)) {
    content = applyEdits(content, modify(content, ['plugin', managedIndex], desiredPlugin, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    }));
  }
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}
