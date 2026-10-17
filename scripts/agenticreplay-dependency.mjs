import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// npm ci supplies the release recorded in package-lock.json. The dependency
// selector and lock identify this particular test installation. Recording
// behavior is checked by the real CLI contract, independently of version labels.
export function managedAgenticReplay(root = repositoryRoot) {
  const manifest = readJson(path.join(root, 'package.json'));
  const range = manifest.devDependencies?.agenticreplay;
  if (typeof range !== 'string' || !semver.validRange(range)) {
    throw new Error('Declare a valid AgenticReplay dependency selector in devDependencies');
  }
  const lock = readJson(path.join(root, 'package-lock.json'));
  const lockRange = lock.packages?.['']?.devDependencies?.agenticreplay;
  const lockedVersion = lock.packages?.['node_modules/agenticreplay']?.version;
  if (lockRange !== range || !semver.valid(lockedVersion) || !semver.satisfies(lockedVersion, range)) {
    throw new Error('AgenticReplay lockfile does not resolve the declared dependency selector');
  }
  const installed = readJson(path.join(root, 'node_modules/agenticreplay/package.json'));
  if (installed.name !== 'agenticreplay' || installed.version !== lockedVersion) {
    throw new Error('Installed AgenticReplay does not match the lockfile; run npm ci');
  }
  const binary = path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'agenticreplay.cmd' : 'agenticreplay');
  if (!existsSync(binary)) throw new Error('The installed AgenticReplay executable is missing');
  return { range, version: installed.version, binary };
}
