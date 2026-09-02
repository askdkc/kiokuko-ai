#!/usr/bin/env node
import { supportsNodeVersion, unsupportedNodeMessage } from '../runtime-version.js';

if (!supportsNodeVersion(process.versions.node)) {
  process.stderr.write(`${unsupportedNodeMessage(process.versions.node)}\n`);
  process.exitCode = 1;
} else {
  const { runCli } = await import('../cli.js');
  const exitCode = await runCli();
  if (exitCode !== 0) process.exitCode = exitCode;
}
