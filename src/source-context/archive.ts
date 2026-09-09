import { gunzipSync } from 'node:zlib';
import { SourceFailure } from './process.js';

/** Parse the pinned release's ustar subset. Never extract archive-selected paths. */
export function readReleaseArchive(compressed: Buffer, root: string): { binary: Buffer; license: Buffer } {
  const tar = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map<string, Buffer>();
  const names = new Set<string>();
  const text = (b: Buffer) => b.toString('utf8').replace(/\0.*$/su, '');
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every(b => b === 0)) { ended = true; break; }
    const number = (b: Buffer) => {
      const s = text(b).trim();
      if (!/^[0-7]+$/u.test(s)) throw new SourceFailure('invalid_archive');
      return Number.parseInt(s, 8);
    };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== number(h.subarray(148, 156))) throw new SourceFailure('invalid_archive');
    const prefix = text(h.subarray(345, 500));
    const name = (prefix ? `${prefix}/` : '') + text(h.subarray(0, 100));
    const relative = name.replace(/\/$/u, '');
    if (!relative || /[\\\p{Cc}\p{Cf}]/u.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')
      || !(relative === root || relative.startsWith(`${root}/`)) || names.has(relative)) throw new SourceFailure('invalid_archive');
    names.add(relative);
    const type = h[156], size = number(h.subarray(124, 136));
    if ((type !== 0 && type !== 48 && type !== 53) || (type === 53 && size !== 0)
      || !Number.isSafeInteger(size) || size > 96 * 1024 * 1024 || offset + 512 + size > tar.length)
      throw new SourceFailure('invalid_archive');
    if (type !== 53 && (name === `${root}/ripwire` || name === `${root}/LICENSE`))
      files.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const binary = files.get(`${root}/ripwire`), license = files.get(`${root}/LICENSE`);
  if (!ended || !binary?.length || !license?.length) throw new SourceFailure('invalid_archive');
  return { binary, license };
}
