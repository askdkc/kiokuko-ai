import { createRequire } from 'node:module';

const packageMetadata = createRequire(import.meta.url)('../package.json') as { version?: unknown };

if (typeof packageMetadata.version !== 'string' || packageMetadata.version.length === 0) {
  throw new Error('Kiokuko package version is unavailable');
}

export const PACKAGE_VERSION = packageMetadata.version;
