import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// npm ci supplies the release recorded in package-lock.json. The dependency
// range describes compatibility; the lock and installed package describe this
// particular test run, without imposing a second version policy.
export function managedAgenticReplay(root = repositoryRoot) {
  const manifest = readJson(path.join(root, 'package.json'));
  const range = manifest.devDependencies?.agenticreplay;
  if (typeof range !== 'string' || !semver.validRange(range) || semver.valid(range)) {
    throw new Error('Declare an AgenticReplay compatibility range in devDependencies');
  }
  const lock = readJson(path.join(root, 'package-lock.json'));
  const lockRange = lock.packages?.['']?.devDependencies?.agenticreplay;
  const lockedVersion = lock.packages?.['node_modules/agenticreplay']?.version;
  if (lockRange !== range || !semver.valid(lockedVersion) || !semver.satisfies(lockedVersion, range)) {
    throw new Error('AgenticReplay lockfile does not resolve the declared compatibility range');
  }
  const installed = readJson(path.join(root, 'node_modules/agenticreplay/package.json'));
  if (installed.name !== 'agenticreplay' || installed.version !== lockedVersion) {
    throw new Error('Installed AgenticReplay does not match the lockfile; run npm ci');
  }
  const binary = path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'agenticreplay.cmd' : 'agenticreplay');
  if (!existsSync(binary)) throw new Error('The installed AgenticReplay executable is missing');
  return { range, version: installed.version, binary };
}

export function isCompatibleRecorderVersion(version, range) {
  return semver.valid(version) !== null && semver.satisfies(version, range);
}
