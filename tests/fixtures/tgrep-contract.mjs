// Controlled API fixture. It delegates search to rg; no tgrep performance claim.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('tgrep 99.0.0'); process.exit(0); }
if (process.env.KIOKUKO_TGREP_MISSING_API === '1') { console.error('fixture missing index/search API'); process.exit(2); }
const index = args[args.indexOf('--index-path') + 1];
if (args[0] === 'index') { mkdirSync(index, { recursive: true }); process.exit(0); }
if (args[0] === 'serve') {
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const p = request.params ?? {};
        const result = request.method === 'status' ? { indexing: false, reconcile_running: false, last_reconcile_at: new Date().toISOString(), watch_mode_active: 'native' }
          : { matches: spawnSync('rg', ['--json', '-C', '2', '--max-filesize', '2M', ...(p.fixed_string ? ['-F'] : []), ...(p.case_insensitive ? ['-i'] : []), '--', p.pattern, '.'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => ['match', 'context'].includes(row.type)).map(row => ({ type: row.type, file: row.data.path.text, line: row.data.line_number, content: row.data.lines.text })) };
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
      }
    });
  });
  server.listen(0, '127.0.0.1', () => writeFileSync(path.join(index, 'serve.json'), JSON.stringify({ pid: process.pid, port: server.address().port })));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else {
  const forwarded = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index-path') { i++; continue; }
    if (args[i] !== '--no-index') forwarded.push(args[i]);
  }
  const result = spawnSync('rg', forwarded, { stdio: 'inherit' }); process.exit(result.status ?? 2);
}
