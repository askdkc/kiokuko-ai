import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_FILE_SUFFIX = '.test.ts';

async function collectDirectoryTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedTests = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectDirectoryTests(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX) ? [entryPath] : [];
    }),
  );
  return nestedTests.flat();
}

async function collectTargetTests(target) {
  const targetStats = await stat(target);
  if (targetStats.isDirectory()) {
    return collectDirectoryTests(target);
  }
  if (targetStats.isFile() && target.endsWith(TEST_FILE_SUFFIX)) {
    return [target];
  }
  throw new Error(`Test target must be a directory or ${TEST_FILE_SUFFIX} file: ${target}`);
}

async function collectTestFiles(targets) {
  const testFiles = (await Promise.all(targets.map(collectTargetTests))).flat();
  testFiles.sort();
  if (testFiles.length === 0) {
    throw new Error(`No ${TEST_FILE_SUFFIX} files found in: ${targets.join(', ')}`);
  }
  return testFiles;
}

function runNodeTests(testFiles, testTempRoot) {
  return new Promise((resolve, reject) => {
    const childEnvironment = {
      ...process.env,
      HOME: path.join(testTempRoot, 'home'),
      USERPROFILE: path.join(testTempRoot, 'home'),
      XDG_CONFIG_HOME: path.join(testTempRoot, 'config'),
      XDG_DATA_HOME: path.join(testTempRoot, 'data'),
      XDG_CACHE_HOME: path.join(testTempRoot, 'cache'),
      XDG_STATE_HOME: path.join(testTempRoot, 'state'),
      KIOKUKO_DATA_DIR: path.join(testTempRoot, 'kiokuko-data'),
      TEMP: testTempRoot,
      TMP: testTempRoot,
      TMPDIR: testTempRoot,
    };
    delete childEnvironment.NODE_TEST_CONTEXT;

    const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...(process.env.KIOKUKO_VERIFY_REPORT_DIR ? ['--import=' + pathToFileURL(path.resolve(import.meta.dirname, 'verification-test-environment.mjs')).href, '--test-reporter=tap', '--test-reporter-destination=stdout', '--test-reporter=' + pathToFileURL(path.resolve(import.meta.dirname, 'verification-reporter.mjs')).href, '--test-reporter-destination=' + path.join(process.env.KIOKUKO_VERIFY_REPORT_DIR, 'reporter.txt')] : []), '--test-concurrency=4', ...testFiles], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Test process terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function run() {
  const targets = process.argv.length > 2 ? process.argv.slice(2) : ['tests'];
  const testFiles = await collectTestFiles(targets);
  const testTempRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-test-run-'));

  try {
    await mkdir(path.join(testTempRoot, 'home'), { recursive: true });
    return await runNodeTests(testFiles, testTempRoot);
  } finally {
    await rm(testTempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

try {
  process.exitCode = await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
