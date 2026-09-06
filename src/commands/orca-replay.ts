import { spawn } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';

const ORCA_PACKAGE = 'orcareplay';
const ORCA_ALIAS_MARKER = '# managed by kiokuko-ai setup: orca-opencode';
const ORCA_ALIAS_LINE = `alias orca-opencode='orca record opencode'`;
const ORCA_ALIAS_BLOCK = `${ORCA_ALIAS_MARKER}\n${ORCA_ALIAS_LINE}\n`;
const MAX_RC_BYTES = 1024 * 1024;
const YES_ANSWER = /^(?:y|yes|はい)$/iu;

export interface OrcaReplayInstallInvocation {
  readonly command: 'npm' | 'sudo';
  readonly args: readonly string[];
}

/** Select the global install invocation without assuming every Unix prefix needs root. */
export function orcaReplayInstallInvocation(
  platform: NodeJS.Platform = process.platform,
): OrcaReplayInstallInvocation {
  const args = ['install', '--global', ORCA_PACKAGE];
  return platform === 'linux'
    ? { command: 'sudo', args: ['npm', ...args] }
    : { command: 'npm', args };
}

export type OrcaReplaySpawner = (command: string, args: readonly string[]) => Promise<void>;

export const spawnOrcaReplayInstall: OrcaReplaySpawner = (command, args) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`));
  });
});

/** Probe the `orca` CLI so an existing installation is reused instead of reinstalled. */
export const checkOrcaInstalled: OrcaReplaySpawner = (command, args) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'ignore' });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`exit code ${code ?? 'unknown'}`));
  });
});

export function orcaAliasBlock(): string {
  return ORCA_ALIAS_BLOCK;
}

export function shellRcPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform === 'win32') return undefined;
  const shell = environment.SHELL;
  if (typeof shell !== 'string' || shell.length === 0 || shell.length > 4096) return undefined;
  const name = basename(shell);
  if (name.endsWith('zsh')) return '.zshrc';
  if (name.endsWith('bash')) return '.bashrc';
  return undefined;
}

export type OrcaAliasAppendResult =
  | { readonly appended: true }
  | { readonly appended: false; readonly reason: 'already_present' }
  | { readonly appended: false; readonly reason: 'rc_unresolved' };

/** Append the orca-opencode alias once, guarded by an idempotent sentinel marker. */
export async function appendOrcaAlias(
  rcPath: string | undefined,
): Promise<OrcaAliasAppendResult> {
  if (rcPath === undefined) return { appended: false, reason: 'rc_unresolved' };
  let existing = '';
  try {
    existing = await readFile(rcPath, { encoding: 'utf8', flag: 'r' });
    if (existing.length > MAX_RC_BYTES) return { appended: false, reason: 'rc_unresolved' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { appended: false, reason: 'rc_unresolved' };
  }
  if (existing.includes(ORCA_ALIAS_MARKER)) return { appended: false, reason: 'already_present' };
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(rcPath, `${separator}${ORCA_ALIAS_BLOCK}`, { encoding: 'utf8' });
  return { appended: true };
}

export interface OrcaReplayPromptOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

interface OrcaReplayQuestion {
  question(query: string): Promise<string>;
}

async function askOrcaOptIn(prompt: OrcaReplayQuestion, output: NodeJS.WritableStream): Promise<boolean> {
  output.write('OrcaReplay can record OpenCode sessions so kiokuko can deliver replay context as advisory data.\n');
  output.write('This installs the orcareplay package globally and does not change how the opencode command runs.\n');
  const answer = (await prompt.question('Enable OrcaReplay recording support? [y/N] ')).trim();
  return YES_ANSWER.test(answer);
}

export interface OrcaReplayEnableOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnInstall?: OrcaReplaySpawner;
  readonly checkInstalled?: OrcaReplaySpawner;
}

export interface OrcaReplayEnableSummary {
  readonly accepted: boolean;
  readonly installed: 'installed' | 'already_installed' | 'failed' | 'skipped';
  readonly alias: 'appended' | 'already_present' | 'rc_unresolved' | 'skipped';
}

interface OrcaReplayQuestion {
  question(query: string): Promise<string>;
}

async function askAliasConfirmation(
  prompt: OrcaReplayQuestion,
  output: NodeJS.WritableStream,
  rcPath: string,
): Promise<boolean> {
  const answer = (await prompt.question(`Add the orca-opencode alias to ${rcPath}? [y/N] `)).trim();
  return YES_ANSWER.test(answer);
}

async function reportManualFallback(
  output: NodeJS.WritableStream,
  install: OrcaReplayInstallInvocation,
  rcPath: string | undefined,
): Promise<void> {
  output.write(`OrcaReplay installation failed. Run it manually: ${install.command} ${install.args.join(' ')}\n`);
  output.write(`Then add this line to ${rcPath ?? 'your shell configuration'}:\n${ORCA_ALIAS_LINE}\n`);
}

/** Run the opt-in OrcaReplay enablement flow after a successful setup. */
export async function enableOrcaReplayIntegration(
  options: OrcaReplayEnableOptions,
): Promise<OrcaReplayEnableSummary> {
  const output = options.output;
  const input = options.input;
  if ((input as { readableEnded?: boolean }).readableEnded === true) {
    return { accepted: false, installed: 'skipped', alias: 'skipped' };
  }
  const prompt = createInterface({ input, output });
  try {
    const accepted = await askOrcaOptIn(prompt, output);
    if (!accepted) {
      return { accepted: false, installed: 'skipped', alias: 'skipped' };
    }
    const install = orcaReplayInstallInvocation(options.platform);
    const check = options.checkInstalled ?? checkOrcaInstalled;
    let alreadyInstalled = false;
    try {
      await check('orca', ['--version']);
      alreadyInstalled = true;
    } catch {
      // Absent or broken `orca` CLI: proceed with the global install.
    }
    if (!alreadyInstalled) {
      try {
        await (options.spawnInstall ?? spawnOrcaReplayInstall)(install.command, install.args);
      } catch (error) {
        const cause = error instanceof Error ? `: ${error.message}` : '';
        output.write(`OrcaReplay installation failed${cause}\n`);
        await reportManualFallback(output, install, shellRcPath(options.platform, options.environment));
        return { accepted: true, installed: 'failed', alias: 'skipped' };
      }
    }
    const rcPath = shellRcPath(options.platform, options.environment);
    if (rcPath === undefined) {
      output.write(`Add this line to your shell configuration to enable the shorthand:\n${ORCA_ALIAS_LINE}\n`);
      return { accepted: true, installed: alreadyInstalled ? 'already_installed' : 'installed', alias: 'rc_unresolved' };
    }
    const confirmAlias = await askAliasConfirmation(prompt, output, rcPath);
    if (!confirmAlias) {
      output.write(`Skipped. Add this line manually if you want the shorthand:\n${ORCA_ALIAS_LINE}\n`);
      return { accepted: true, installed: alreadyInstalled ? 'already_installed' : 'installed', alias: 'skipped' };
    }
    const aliasResult = await appendOrcaAlias(rcPath);
    return {
      accepted: true,
      installed: alreadyInstalled ? 'already_installed' : 'installed',
      alias: aliasResult.appended ? 'appended' : aliasResult.reason,
    };
  } finally {
    prompt.close();
  }
}
