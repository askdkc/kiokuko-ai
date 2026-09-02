import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { getEmbeddingPresetDirectory, type PathEnvironment } from '../config/paths.js';
import { assertNoUnexpectedModelFiles, MODEL_MANIFEST_FILENAME, serializeModelManifest, verifyInstalledModelDirectory, verifyModelDirectory } from './model-manifest.js';
import { createHuggingFaceModelDownloader, type ModelDownloader, type ModelDownloadProgress } from './model-download.js';
import type { LocalEmbeddingPreset } from './presets/manifest.js';

export interface InstalledModel {
  readonly installation: 'installed' | 'reused';
  readonly directory: string;
  readonly relativePath: string;
  readonly totalBytes: number;
  readonly manifestHash: string;
}

export interface InstallModelOptions extends PathEnvironment {
  readonly downloader?: ModelDownloader;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ModelDownloadProgress) => void;
}

function relativeModelPath(preset: LocalEmbeddingPreset): string {
  return path.posix.join('models', 'embeddings', preset.id, preset.revision);
}

async function existingDirectory(pathname: string): Promise<boolean> {
  try {
    const stat = await lstat(pathname);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', 'Existing model installation is not a private directory');
    return true;
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function installEmbeddingModel(
  preset: LocalEmbeddingPreset,
  options: InstallModelOptions = {},
): Promise<InstalledModel> {
  const downloader = options.downloader ?? createHuggingFaceModelDownloader();
  const finalDirectory = getEmbeddingPresetDirectory(preset.id, preset.revision, options);
  if (await existingDirectory(finalDirectory)) {
    const manifest = await verifyInstalledModelDirectory(finalDirectory, preset);
    return { installation: 'reused', directory: finalDirectory, relativePath: relativeModelPath(preset), totalBytes: manifest.totalBytes, manifestHash: manifest.artifactManifestHash };
  }

  const stagingParent = path.dirname(path.dirname(finalDirectory));
  const stagingDirectory = path.join(stagingParent, '.staging', randomUUID());
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  try {
    const downloaded = await downloader.download(preset, stagingDirectory, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    const manifest = await verifyModelDirectory(downloaded.directory, preset);
    await assertNoUnexpectedModelFiles(downloaded.directory, preset);
    await writeFile(path.join(downloaded.directory, MODEL_MANIFEST_FILENAME), serializeModelManifest(manifest), { mode: 0o600, flag: 'wx' });
    await chmod(downloaded.directory, 0o700);
    await mkdir(path.dirname(finalDirectory), { recursive: true, mode: 0o700 });
    if (await existingDirectory(finalDirectory)) {
      const existing = await verifyInstalledModelDirectory(finalDirectory, preset);
      if (existing.artifactManifestHash !== manifest.artifactManifestHash) throw new KiokukoError('CONFLICT', 'A different model installation already exists for this preset revision');
      return { installation: 'reused', directory: finalDirectory, relativePath: relativeModelPath(preset), totalBytes: existing.totalBytes, manifestHash: existing.artifactManifestHash };
    }
    try {
      await rename(downloaded.directory, finalDirectory);
      return { installation: 'installed', directory: finalDirectory, relativePath: relativeModelPath(preset), totalBytes: manifest.totalBytes, manifestHash: manifest.artifactManifestHash };
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOTEMPTY'
        && await existingDirectory(finalDirectory)) {
        const existing = await verifyInstalledModelDirectory(finalDirectory, preset);
        return { installation: 'reused', directory: finalDirectory, relativePath: relativeModelPath(preset), totalBytes: existing.totalBytes, manifestHash: existing.artifactManifestHash };
      }
      throw error;
    }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
