// Reference streaming proxy for the Lume frontier environment.
//
// TEST DOUBLE, not a product component. It proves two things without touching
// the real Aftergraph/Lume service: (1) a compliant streaming proxy passes
// every scenario, (2) each --sabotage=<class> injects exactly one violation
// class and the harness must FAIL on it.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const ALLOWED_ORIGIN = 'https://lume.example.com';
const UPSTREAM_SECRET = 'sk-live-9f1e2';

export function parseSabotage(argv) {
  const raw = argv.filter((a) => a.startsWith('--sabotage=')).map((a) => a.slice('--sabotage='.length));
  const set = new Set();
  for (const r of raw) {
    set.add(r);
    if (r === 'cors') set.add('cors-boundary');
    if (r === 'cors-boundary') set.add('cors');
  }
  return set;
}

export function startReferenceProxy({ upstreamPort, port, host = '127.0.0.1', sabotage = new Set() }) {
  const sab = sabotage;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'OPTIONS') {
        const origin = req.headers.origin || '';
        const reflect = sab.has('cors');
        const headers = {
          'access-control-allow-origin': reflect ? origin : ALLOWED_ORIGIN,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'POST, OPTIONS',
          vary: 'Origin'
        };
        res.writeHead(204, headers);
        return res.end();
      }

      const upstreamReq = http.request(
        {
          host: '127.0.0.1',
          port: upstreamPort,
          method: 'POST',
          path: '/upstream/chat',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${UPSTREAM_SECRET} REFERENCE-ONLY`,
            'x-request-id': randomUUID()
          }
        },
        (up) => {
          if (up.statusCode === 503) {
            if (sab.has('upstream-failure')) {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              return res.end();
            }
            res.writeHead(503, { 'content-type': 'application/json' });
            return res.end('{"error":"upstream unavailable"}');
          }
          const headers = {
            'content-type': sab.has('content-type') ? 'text/plain' : 'text/event-stream',
            'x-request-id': up.headers['x-request-id'] || randomUUID()
          };
          if (sab.has('secret-leak')) {
            headers['x-debug-upstream'] = String(up.headers['x-upstream-secret'] || UPSTREAM_SECRET);
          }
          res.writeHead(Number(up.statusCode), headers);
          let sawUpstreamEnd = false;
          up.on('data', (d) => res.write(d));
          up.on('end', () => {
            sawUpstreamEnd = true;
            res.end();
          });
          const onBroken = () => {
            if (sab.has('sse-integrity')) {
              res.write('data: {"delta":" the end."}\n\n\n');
              res.end();
            } else {
              try { res.destroy(); } catch {}
            }
          };
          up.on('aborted', onBroken);
          up.on('error', () => {
            if (sawUpstreamEnd) return;
            onBroken();
          });
        }
      );
      upstreamReq.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end('{"error":"upstream unreachable"}');
        } else {
          res.destroy();
        }
      });
      const body = Buffer.concat(chunks);
      if (body.length) upstreamReq.write(body);
      upstreamReq.end();
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port: server.address().port })));
}
