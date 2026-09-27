import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

/** Serve the exact packed artifact under its ordinary npm name in isolated host tests. */
export async function startPackedRegistry(tarballPath, manifest) {
  const archive = await readFile(tarballPath);
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  const requests = [];
  const failures = [];
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requestCount++;
    requests.push(pathname);
    if (requests.length > 10) requests.shift();
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (pathname === '/kiokuko-ai' || pathname === `/kiokuko-ai/${manifest.version}`) {
      const tarball = `${origin}/kiokuko-ai/-/kiokuko-ai-${manifest.version}.tgz`;
      const version = { ...manifest, dist: { tarball, integrity } };
      const value = pathname === '/kiokuko-ai'
        ? { name: 'kiokuko-ai', 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } }
        : version;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
      return;
    }
    if (pathname === `/kiokuko-ai/-/kiokuko-ai-${manifest.version}.tgz`) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length });
      response.end(archive);
      return;
    }
    try {
      const upstream = await fetch(`https://registry.npmjs.org${request.url}`, {
        method: request.method, headers: { accept: request.headers.accept ?? 'application/json' },
      });
      if (!upstream.ok && failures.length < 10) failures.push({ path: pathname, status: upstream.status });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      if (failures.length < 10) failures.push({ path: pathname, status: 502 });
      response.writeHead(502);
      response.end('registry upstream unavailable');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    diagnostics: () => ({ requestCount, lastRequests: [...requests], failures: [...failures] }),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
