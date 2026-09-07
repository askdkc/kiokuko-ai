import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { readBoundedTraceFile } from '../trace/bounded-read.js';
import { withManagedFileLock } from '../managed-files/coordinator.js';
import { atomicReplaceTextWithGuard, assertAtomicCleanupComplete } from '../agent-file/atomic-write.js';
import type { PathEnvironment } from '../config/paths.js';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline/promises';
const ORCA_PACKAGE = 'orcareplay';
const ORCA_ALIAS_MARKER = '# managed by kiokuko-ai setup: orca-opencode';
const ORCA_ALIAS_LINE = `alias orca-opencode='kiokuko-ai trace record --'`;
const ORCA_ALIAS_BLOCK = `${ORCA_ALIAS_MARKER}\n${ORCA_ALIAS_LINE}\n`;
const MAX_RC_BYTES = 1024 * 1024;
const YES_ANSWER = /^(?:y|yes|はい)$/iu;
export interface OrcaReplayInstallInvocation {
    readonly command: 'npm' | 'sudo';
    readonly args: readonly string[];
}
/** Select the global install invocation without assuming every Unix prefix needs root. */
export function orcaReplayInstallInvocation(platform: NodeJS.Platform = process.platform): OrcaReplayInstallInvocation {
    const args = ['install', '--global', ORCA_PACKAGE];
    return { command: 'npm', args };
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
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0)
        resolve();
    else
        reject(new Error('Orca probe failed')); });
});
export function orcaAliasBlock(): string {
    return ORCA_ALIAS_BLOCK;
}
export function shellRcPath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): string | undefined {
    if (platform === 'win32')
        return undefined;
    const shell = environment.SHELL;
    if (typeof shell !== 'string' || shell.length > 4096 || /[\x00-\x1f\x7f]/u.test(shell))
        return undefined;
    const name = basename(shell);
    if (name !== 'zsh' && name !== 'bash')
        return undefined;
    const base = name === 'zsh' && Object.hasOwn(environment, 'ZDOTDIR') ? environment.ZDOTDIR : environment.HOME ?? (environment === process.env ? homedir() : undefined);
    if (typeof base !== 'string' || !isAbsolute(base) || base.length > 4096 || /[\x00-\x1f\x7f]/u.test(base))
        return undefined;
    return join(base, name === 'zsh' ? '.zshrc' : '.bashrc');
}
export type OrcaAliasAppendResult = {
    readonly appended: true;
} | {
    readonly appended: false;
    readonly reason: 'already_present' | 'rc_unresolved' | 'alias_conflict';
};
export async function appendOrcaAlias(rcPath: string | undefined, environment: PathEnvironment = {}): Promise<OrcaAliasAppendResult> {
    if (rcPath === undefined || !isAbsolute(rcPath))
        return { appended: false, reason: 'rc_unresolved' };
    try {
        return await withManagedFileLock(rcPath, async (guard) => {
            const parent = await realpath(dirname(rcPath));
            const target = join(parent, basename(rcPath));
            const parentStat = await lstat(parent);
            let expected;
            try {
                const stat = await lstat(target);
                if (!stat.isFile() || stat.isSymbolicLink())
                    return { appended: false, reason: 'rc_unresolved' } as const;
                const raw = await readBoundedTraceFile(target, parent, MAX_RC_BYTES);
                expected = { content: new TextDecoder('utf-8', { fatal: true }).decode(raw), mode: stat.mode & 0o777, identity: { device: BigInt(stat.dev), inode: BigInt(stat.ino) } };
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
            const existing = expected?.content ?? '';
            const newline = existing.includes('\r\n') ? '\r\n' : '\n';
            const lines = existing.split(/\r?\n/u);
            const marker = lines.indexOf(ORCA_ALIAS_MARKER);
            const aliases = lines.map((line, index) => ({ line, index })).filter(x => /^\s*(?:alias\s+orca-opencode=|function\s+orca-opencode\b|orca-opencode\s*\(\))/u.test(x.line));
            const old = "alias orca-opencode='orca record opencode'";
            if (aliases.some(x => marker < 0 || x.index !== marker + 1 || ![old, ORCA_ALIAS_LINE].includes(x.line)) || (marker >= 0 && (aliases.length !== 1 || lines.lastIndexOf(ORCA_ALIAS_MARKER) !== marker)))
                return { appended: false, reason: 'alias_conflict' } as const;
            if (marker >= 0 && lines[marker + 1] === ORCA_ALIAS_LINE)
                return { appended: false, reason: 'already_present' } as const;
            const content = marker >= 0 ? existing.replace(`${ORCA_ALIAS_MARKER}${newline}${old}`, `${ORCA_ALIAS_MARKER}${newline}${ORCA_ALIAS_LINE}`)
                : `${existing}${existing && !existing.endsWith('\n') ? newline : ''}${ORCA_ALIAS_MARKER}${newline}${ORCA_ALIAS_LINE}${newline}`;
            const result = await atomicReplaceTextWithGuard(target, content, guard, expected, { device: BigInt(parentStat.dev), inode: BigInt(parentStat.ino) }, expected?.mode ?? 0o644, undefined, MAX_RC_BYTES);
            assertAtomicCleanupComplete(result);
            return { appended: true } as const;
        }, environment);
    }
    catch {
        return { appended: false, reason: 'rc_unresolved' };
    }
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
    readonly interactive?: boolean;
    readonly dryRun?: boolean;
    readonly cwd?: string;
}
export interface OrcaReplayEnableSummary {
    readonly accepted: boolean;
    readonly installed: 'installed' | 'already_installed' | 'failed' | 'skipped';
    readonly alias: 'alias_conflict' | 'appended' | 'already_present' | 'rc_unresolved' | 'skipped';
}
interface OrcaReplayQuestion {
    question(query: string): Promise<string>;
}
async function askAliasConfirmation(prompt: OrcaReplayQuestion, output: NodeJS.WritableStream, rcPath: string): Promise<boolean> {
    const answer = (await prompt.question(`Add the orca-opencode alias to ${rcPath}? [y/N] `)).trim();
    return YES_ANSWER.test(answer);
}
async function reportManualFallback(output: NodeJS.WritableStream, install: OrcaReplayInstallInvocation, rcPath: string | undefined): Promise<void> {
    output.write(`OrcaReplay installation failed. Run it manually: ${install.command} ${install.args.join(' ')}\n`);
    output.write(`Then add this line to ${rcPath ?? 'your shell configuration'}:\n${ORCA_ALIAS_LINE}\n`);
}
/** Run the opt-in OrcaReplay enablement flow after a successful setup. */
export async function enableOrcaReplayIntegration(options: OrcaReplayEnableOptions): Promise<OrcaReplayEnableSummary> {
    const output = options.output;
    const input = options.input;
    if (options.dryRun || options.interactive === false || (options.interactive !== true && !(input as {
        isTTY?: boolean;
    }).isTTY) || (input as {
        readableEnded?: boolean;
    }).readableEnded === true) {
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
        }
        catch {
            // Absent or broken `orca` CLI: proceed with the global install.
        }
        if (!alreadyInstalled) {
            try {
                await (options.spawnInstall ?? spawnOrcaReplayInstall)(install.command, install.args);
                await check('orca', ['--version']);
            }
            catch (error) {
                const cause = error instanceof Error ? `: ${error.message}` : '';
                output.write(`OrcaReplay installation failed${cause}\n`);
                await reportManualFallback(output, install, shellRcPath(options.platform, options.environment));
                return { accepted: true, installed: 'failed', alias: 'skipped' };
            }
        }
        const rcPath = shellRcPath(options.platform, options.environment);
        if (rcPath !== undefined) {
            const legacy = join(options.cwd ?? process.cwd(), basename(rcPath));
            if (legacy !== rcPath)
                try {
                    const root = await realpath(dirname(legacy));
                    const bytes = await readBoundedTraceFile(join(root, basename(legacy)), root, MAX_RC_BYTES);
                    if (bytes.toString('utf8').includes(ORCA_ALIAS_MARKER))
                        output.write(`Legacy managed alias found at ${legacy}; inspect it manually.\n`);
                }
                catch { /* An absent or unreadable legacy rc never authorizes a mutation. */ }
        }
        if (rcPath === undefined) {
            output.write(`Add this line to your shell configuration to enable the shorthand:\n${ORCA_ALIAS_LINE}\n`);
            return { accepted: true, installed: alreadyInstalled ? 'already_installed' : 'installed', alias: 'rc_unresolved' };
        }
        const confirmAlias = await askAliasConfirmation(prompt, output, rcPath);
        if (!confirmAlias) {
            output.write(`Skipped. Add this line manually if you want the shorthand:\n${ORCA_ALIAS_LINE}\n`);
            return { accepted: true, installed: alreadyInstalled ? 'already_installed' : 'installed', alias: 'skipped' };
        }
        const aliasResult = await appendOrcaAlias(rcPath, { ...(options.environment ? { env: options.environment } : {}), ...(options.platform ? { platform: options.platform } : {}) });
        if (!aliasResult.appended && aliasResult.reason !== 'already_present')
            output.write(`Alias update could not be confirmed (${aliasResult.reason}); inspect ${rcPath} manually.\n`);
        return {
            accepted: true,
            installed: alreadyInstalled ? 'already_installed' : 'installed',
            alias: aliasResult.appended ? 'appended' : aliasResult.reason,
        };
    }
    finally {
        prompt.close();
    }
}
