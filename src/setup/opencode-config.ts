import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type ParseError } from 'jsonc-parser';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { PACKAGE_VERSION } from '../package-version.js';
import { isSkillDiscoveryMode, SKILL_DISCOVERY_ENV } from '../skills/config.js';
import type { SkillDiscoveryMode } from '../skills/types.js';
import type { DelimitedBlockResult } from './managed-text.js';
import { isSetupOpenCodeMcpIdentityConflict, setupOpenCodeMcpIdentityConflict } from './mcp-conflict.js';
import { assertStrictJsonSyntax } from './strict-json.js';
import type { OpenCodeRuntimeInvocation } from '../opencode/hook-effect.js';
import { renderExecutionConfig } from './execution-config.js';
import { canonicalContentHash } from '../serialization/validate.js';

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
  return typeof value === 'string' ? value
    : Array.isArray(value) && typeof value[0] === 'string' ? value[0]
      : typeof object(value)?.package === 'string' ? object(value)?.package as string : undefined;
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

function validatePluginEntries(root: Record<string, unknown>): { legacy: unknown[]; current: unknown[] } {
  if (root.plugin !== undefined && !Array.isArray(root.plugin)) validation('OpenCode config plugin must be an array');
  if (root.plugins !== undefined && !Array.isArray(root.plugins)) validation('OpenCode config plugins must be an array');
  const legacy = root.plugin as unknown[] | undefined ?? [];
  const current = root.plugins as unknown[] | undefined ?? [];
  for (const entry of [...legacy, ...current]) {
    if (pluginPackage(entry) === undefined) validation('OpenCode config plugin entry is invalid');
    if (pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE
      && Array.isArray(entry) && entry.length > 1 && object(entry[1]) === undefined) conflict();
  }
  return { legacy, current };
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
  if (server === undefined || !hasExactKeys(server, ['type', 'command', 'disabled', 'environment'])) return false;
  if (server.type !== 'local' || server.disabled !== false || !validEnvironment(server.environment)) return false;
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

function sameManagedServer(legacy: unknown, current: unknown, runtime?: OpenCodeRuntimeInvocation): boolean {
  if (!isLegacyManagedServer(legacy) || !isCanonicalManagedServer(current, runtime)) return false;
  const old = legacy as { command: string[]; environment: Record<string, unknown> };
  const next = current as { command: string[]; environment: Record<string, unknown> };
  const sameTarget = runtime === undefined
    ? old.command[0] === next.command[0]
    : old.command[0] === KIOKUKO_OPENCODE_PLUGIN_PACKAGE;
  return sameTarget && canonicalContentHash(old.environment) === canonicalContentHash(next.environment);
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
  const existingOptions = Array.isArray(entry) ? object(entry[1]) : object(object(entry)?.options);
  return { package: specifier, options: { ...existingOptions, ...(runtime ? managedPluginOptions(runtime) : {}) } };
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function conflict(): never {
  setupOpenCodeMcpIdentityConflict('OpenCode config already contains a conflicting kiokuko MCP server');
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
  let plugins: { legacy: unknown[]; current: unknown[] };
  try {
    plugins = validatePluginEntries(root);
  } catch (error) {
    if (isSetupOpenCodeMcpIdentityConflict(error)) return { plugin: 'conflict', mcp: 'conflict' };
    throw error;
  }
  const managedPlugins = [...plugins.legacy, ...plugins.current].filter((entry) => pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE);
  let plugin: OpenCodeIntegrationStatus = managedPlugins.length === 0 ? 'absent' : 'current';
  if (managedPlugins.length > 1) plugin = 'duplicate';
  else if (managedPlugins[0] !== undefined) {
    const entry = managedPlugins[0];
    if (runtime !== undefined) {
      const options = object(object(entry)?.options);
      plugin = plugins.current.includes(entry) && pluginSpecifier(entry) === managedOpenCodePluginSpecifier(runtime.packageVersion)
        && options?.protocolVersion === runtime.protocolVersion
        && options.packageVersion === runtime.packageVersion
        && options.nodeExecutable === runtime.nodeExecutable
        && options.cliScript === runtime.cliScript
        ? 'current'
        : pluginVersion(entry) === undefined ? 'legacy' : 'outdated';
    } else {
      plugin = plugins.current.includes(entry) && pluginVersion(entry) === PACKAGE_VERSION ? 'current' : pluginVersion(entry) === undefined ? 'legacy' : 'outdated';
    }
  }
  const mcpRoot = object(root.mcp);
  if (root.mcp !== undefined && mcpRoot === undefined) return { plugin, mcp: 'conflict' };
  const server = object(mcpRoot?.servers)?.kiokuko;
  const legacyServer = mcpRoot?.kiokuko;
  if (server !== undefined && legacyServer !== undefined) {
    return { plugin, mcp: sameManagedServer(legacyServer, server, runtime) ? 'legacy' : 'conflict' };
  }
  if (server === undefined && legacyServer === undefined) return { plugin, mcp: 'absent' };
  if (runtime !== undefined && isCanonicalManagedServer(server, runtime)) return { plugin, mcp: 'current' };
  if (runtime === undefined && isCanonicalManagedServer(server)) return { plugin, mcp: 'current' };
  if (isLegacyManagedServer(legacyServer)) return { plugin, mcp: 'legacy' };
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

/** Read the existing choice only from a recognized managed MCP configuration. */
export function readManagedSkillDiscoveryMode(existing: string | undefined, runtime?: OpenCodeRuntimeInvocation): SkillDiscoveryMode | undefined {
  if (existing === undefined) return undefined;
  const mcp = object(parseOpenCodeRoot(existing).mcp);
  const server = object(mcp?.servers)?.kiokuko ?? mcp?.kiokuko;
  if (!isCanonicalManagedServer(server, runtime) && !isLegacyManagedServer(server)) return undefined;
  return object(object(server)?.environment)?.[SKILL_DISCOVERY_ENV] as SkillDiscoveryMode;
}

export function renderOpenCodeConfig(
  existing: string | undefined,
  command = KIOKUKO_OPENCODE_PLUGIN_PACKAGE,
  skillDiscoveryMode?: SkillDiscoveryMode,
  options: { replaceConflictingIdentity?: boolean; runtime?: OpenCodeRuntimeInvocation; ennoOduno?: 'ask' | 'on' | 'off'; executionTemplates?: boolean } = {},
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
  const mcpServers = object(mcp?.servers);
  if (mcp?.servers !== undefined && mcpServers === undefined) validation('OpenCode config has an invalid mcp.servers object');
  const currentServer = mcpServers?.kiokuko ?? mcp?.kiokuko;
  if (mcpServers?.kiokuko !== undefined && mcp?.kiokuko !== undefined
    && !sameManagedServer(mcp.kiokuko, mcpServers.kiokuko, options.runtime)) conflict();
  const runtime = options.runtime;
  const canonicalServer = mcpServers?.kiokuko !== undefined && (runtime === undefined
    ? isCanonicalManagedServer(mcpServers.kiokuko)
    : isCanonicalManagedServer(mcpServers.kiokuko, runtime)) ? mcpServers.kiokuko : undefined;
  const legacyServer = mcp?.kiokuko !== undefined && isLegacyManagedServer(mcp.kiokuko);
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
  const desiredServer = {
    type: 'local',
    command: mcpCommand,
    disabled: false,
    environment: { [SKILL_DISCOVERY_ENV]: effectiveSkillDiscoveryMode },
  };
  let content = source;
  const set = (keys: (string | number)[], value: unknown) => {
    content = applyEdits(content, modify(content, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }));
  };
  if (canonicalServer) {
    for (const [key, value] of Object.entries(desiredServer)) {
      if (JSON.stringify(object(canonicalServer)?.[key]) !== JSON.stringify(value)) {
        if (key === 'environment') set(['mcp', 'servers', 'kiokuko', 'environment', SKILL_DISCOVERY_ENV], effectiveSkillDiscoveryMode);
        else set(['mcp', 'servers', 'kiokuko', key], value);
      }
    }
    if (mcp?.kiokuko !== undefined) set(['mcp', 'kiokuko'], undefined);
  } else {
    set(['mcp', 'servers', 'kiokuko'], desiredServer);
    if (mcp?.kiokuko !== undefined && (legacyServer || options.replaceConflictingIdentity)) set(['mcp', 'kiokuko'], undefined);
  }
  const oldIndex = plugins.legacy.findIndex(entry => pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE);
  const newIndex = plugins.current.findIndex(entry => pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE);
  if (plugins.legacy.filter(entry => pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE).length > 1
    || plugins.current.filter(entry => pluginPackage(entry) === KIOKUKO_OPENCODE_PLUGIN_PACKAGE).length > 1) conflict();
  if (oldIndex >= 0 && plugins.legacy.slice(oldIndex + 1).length > 0) {
    throw new KiokukoError('CONFLICT', 'Moving Kiokuko would reorder other legacy plugins');
  }
  const oldEntry = oldIndex < 0 ? undefined : plugins.legacy[oldIndex];
  const newEntry = newIndex < 0 ? undefined : plugins.current[newIndex];
  const oldOptionsNode = oldIndex >= 0 && Array.isArray(oldEntry)
    ? findNodeAtLocation(parseTree(source)!, ['plugin', oldIndex, 1]) : undefined;
  const oldOptionsText = oldOptionsNode ? source.slice(oldOptionsNode.offset, oldOptionsNode.offset + oldOptionsNode.length) : undefined;
  if (oldEntry !== undefined && newEntry !== undefined
    && canonicalContentHash(updatedPluginEntry(oldEntry, runtime)) !== canonicalContentHash(updatedPluginEntry(newEntry, runtime))) conflict();
  const desiredPlugin = updatedPluginEntry(newEntry ?? oldEntry, runtime);
  if (oldIndex >= 0) set(['plugin', oldIndex], undefined);
  let targetIndex = newIndex;
  if (newIndex < 0) {
    targetIndex = oldIndex >= 0 ? 0 : plugins.current.length;
    const next = oldIndex >= 0 ? [desiredPlugin, ...plugins.current] : [...plugins.current, desiredPlugin];
    set(['plugins'], next);
    if (oldOptionsText !== undefined) {
      const node = findNodeAtLocation(parseTree(content)!, ['plugins', targetIndex, 'options']);
      if (node) {
        let preservedOptions = oldOptionsText;
        const desiredOptions = (desiredPlugin as { options: Record<string, unknown> }).options;
        const existingOptions = object(parse(preservedOptions)) ?? {};
        for (const [key, value] of Object.entries(desiredOptions)) {
          if (JSON.stringify(existingOptions[key]) !== JSON.stringify(value)) {
            preservedOptions = applyEdits(preservedOptions, modify(preservedOptions, [key], value,
              { formattingOptions: { insertSpaces: true, tabSize: 2, eol } }));
          }
        }
        content = content.slice(0, node.offset) + preservedOptions + content.slice(node.offset + node.length);
      }
    }
  } else if (JSON.stringify(newEntry) !== JSON.stringify(desiredPlugin)) {
    if (object(newEntry)) {
      const desired = desiredPlugin as { package: string; options: Record<string, unknown> };
      const existingOptions = object(object(newEntry)?.options);
      if (pluginSpecifier(newEntry) !== desired.package) set(['plugins', newIndex, 'package'], desired.package);
      for (const [key, value] of Object.entries(desired.options)) {
        if (JSON.stringify(existingOptions?.[key]) !== JSON.stringify(value)) {
          set(['plugins', newIndex, 'options', key], value);
        }
      }
    } else set(['plugins', newIndex], desiredPlugin);
  }
  if (options.executionTemplates) content = renderExecutionConfig(content, targetIndex, options.ennoOduno);
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}
