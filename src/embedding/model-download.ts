import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { createModelManifest, validatePresetManifest, type VerifiedModelManifest } from './model-manifest.js';
import type { LocalEmbeddingPreset } from './presets/manifest.js';

export interface ModelDownloadProgress {
  readonly file: string;
  readonly completedBytes: number;
  readonly totalBytes: number;
}

export interface DownloadedModel {
  readonly directory: string;
  readonly manifest: VerifiedModelManifest;
}

export interface ModelDownloader {
  download(
    preset: LocalEmbeddingPreset,
    stagingDirectory: string,
    options?: { readonly signal?: AbortSignal; readonly onProgress?: (progress: ModelDownloadProgress) => void },
  ): Promise<DownloadedModel>;
}

type HubDownloadFile = (params: {
  repo: { type: 'model'; name: string };
  path: string;
  revision: string;
  xet: boolean;
  fetch?: typeof fetch;
}) => Promise<Blob | null>;

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Embedding model download was interrupted');
}

export function createHuggingFaceModelDownloader(options: { readonly downloadFile?: HubDownloadFile } = {}): ModelDownloader {
  return {
    download: async (preset, stagingDirectory, downloadOptions = {}) => {
      validatePresetManifest(preset);
      const downloadFile = options.downloadFile ?? (await import('@huggingface/hub')).downloadFile as HubDownloadFile;
      const manifest = createModelManifest(preset);
      await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
      let completedBytes = 0;
      for (const file of preset.files) {
        aborted(downloadOptions.signal);
        const blob = await downloadFile({
          repo: { type: 'model', name: preset.artifactRepository },
          path: file.path,
          revision: preset.revision,
          xet: true,
        });
        if (blob === null) throw new KiokukoError('NOT_FOUND', `Pinned model artifact is unavailable: ${file.path}`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        aborted(downloadOptions.signal);
        if (bytes.byteLength !== file.size) throw new KiokukoError('INTEGRITY_ERROR', `Downloaded model artifact size mismatch: ${file.path}`);
        const target = path.join(stagingDirectory, file.path);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
        completedBytes += bytes.byteLength;
        downloadOptions.onProgress?.({ file: file.path, completedBytes, totalBytes: manifest.totalBytes });
      }
      return { directory: stagingDirectory, manifest };
    },
  };
}
