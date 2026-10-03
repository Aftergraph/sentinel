#!/usr/bin/env node
// Lume frontier testing environment — runner.
//
// Zero-dependency, loopback-only. Two modes:
//   --target http://127.0.0.1:<port>   probe a Lume proxy under test
//   --self-test                        spin up mock upstream + reference proxy
//                                     and run the full scenario pack against it
//
// Every scenario must reach PASS or FAIL; anything ambiguous is INCONCLUSIVE
// and the whole run exits non-zero (fail-closed). Binds loopback only.
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReferenceProxy, parseSabotage } from './reference-proxy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, '..');

const args = process.argv.slice(2);
const sabotage = parseSabotage(args);
const targetIdx = args.indexOf('--target');
const target = targetIdx !== -1 ? args[targetIdx + 1] : null;
const selfTest = args.includes('--self-test');

const URL_BOUND = /^https?:\/\/127\.0\.0\.1(?::\d+)?$/;
if (target && !URL_BOUND.test(target)) {
  console.error('refusing non-loopback target (sandbox boundary): ' + target);
  process.exit(2);
}

function loadScenarios() {
  const dir = join(PACK, 'scenarios');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('no scenarios found');
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function startMockUpstream(port) {
  const server = http.createServer((req, res) => {
    let scenarioId = null;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      scenarioId = body.scenario_id || null;
      const scenario = pendingScenarios.get(scenarioId);
      if (!scenario) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"mock upstream: unknown scenario"}');
      }
      const replay = scenario.upstream_replay;
      if (replay.status === 503) {
        res.writeHead(503, {
          'content-type': replay.headers['content-type'] || 'application/json',
          ...(replay.extra_headers || {})
        });
        replay.body_chunks.forEach((c) => res.write(c));
        return res.end();
      }
      res.writeHead(replay.status, {
        'content-type': replay.headers['content-type'] || 'text/event-stream',
        ...(replay.extra_headers || {})
      });
      let i = 0;
      const sendNext = () => {
        if (i < replay.body_chunks.length) {
          res.write(replay.body_chunks[i++]);
          setTimeout(sendNext, 10);
        } else if (replay.truncate) {
          res.destroy();
        } else {
          res.end();
        }
      };
      sendNext();
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const pendingScenarios = new Map();

async function probe(targetBase, scenario) {
  pendingScenarios.set(scenario.id, scenario);
  const url = new URL(scenario.probe.path, targetBase);
  const headers = { 'content-type': 'application/json', ...(scenario.probe.headers || {}) };
  const method = scenario.probe.method || 'POST';
  const body = method === 'OPTIONS' ? undefined
    : JSON.stringify({ scenario_id: scenario.id, messages: [{ role: 'user', content: 'probe' }] });
  return await new Promise((resolve) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (d) => { chunks.push(d); bytes += d.length; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('aborted', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: true }));
      res.on('error', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: true }));
    });
    req.setTimeout(8000, () => { req.destroy(new Error('probe timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: String(e) }));
    if (body) req.write(body);
    req.end();
  });
}

function evaluate(scenario, r) {
  const fail = [];
  const notes = [];
  if (!r.ok) return { verdict: 'INCONCLUSIVE', fail, notes: ['probe transport error: ' + r.error] };
  const body = r.body || '';
  const headerLines = Object.entries(r.headers || {})
    .map(([k, v]) => `${k.toLowerCase()}: ${Array.isArray(v) ? v.join(',') : String(v)}`.toLowerCase());
  const haystack = (body + '\n' + headerLines.join('\n')).toLowerCase();

  const exp = scenario.expect;
  for (const pat of exp.no_forbidden_patterns_in_response || []) {
    if (haystack.includes(pat.toLowerCase())) fail.push(`forbidden pattern present: ${pat}`);
  }
  for (const h of exp.must_not_send || []) {
    if (headerLines.some((l) => l.startsWith(h.toLowerCase()))) fail.push(`forbidden header sent: ${h}`);
  }
  if (exp.must_not_reflect_origin && headerLines.some((l) => l.includes(exp.must_not_reflect_origin.toLowerCase()))) {
    fail.push(`origin reflected: ${exp.must_not_reflect_origin}`);
  }
  if (exp.not_status && exp.not_status.includes(r.status)) fail.push(`forbidden status ${r.status}`);
  const ct = String((r.headers || {})['content-type'] || '').toLowerCase();
  if (exp.content_type_matches && !exp.content_type_matches.some((m) => ct.includes(m))) {
    fail.push(`content-type "${ct}" matches none of ${exp.content_type_matches.join(', ')}`);
  }
  if (exp.response_is_sse_or_error) {
    const isSse = ct.includes('text/event-stream');
    const isError = r.status >= 400 || /error/.test(body.slice(0, 512));
    if (!isSse && !isError) fail.push('non-SSE, non-error response to stream probe');
  }
  if (exp.must_not_silently_complete && r.aborted === undefined) {
    // transport completed without an abort signal — cannot conclude
    notes.push('probe completed without truncation signal; treating as PASS only if stream surface is well-formed');
  }
  if (exp.must_not_silently_complete && r.aborted !== true && r.status === 200 && !/error|abort|truncat/i.test(body)) {
    fail.push('upstream truncation surfaced as a silent clean 200');
  }
  if (fail.length) return { verdict: 'FAIL', fail, notes };
  return { verdict: 'PASS', fail, notes };
}

async function main() {
  const scenarios = loadScenarios();
  for (const s of scenarios) pendingScenarios.set(s.id, s);
  let cleanup = [];
  let targetBase = target;

  if (selfTest) {
    const upstream = await startMockUpstream(0);
    const proxy = await startReferenceProxy({ upstreamPort: upstream.port, port: 0, sabotage });
    targetBase = `http://127.0.0.1:${proxy.port}`;
    cleanup = [proxy.server, upstream.server];
  }

  const results = [];
  for (const s of scenarios) {
    const r = await probe(targetBase, s);
    const verdict = evaluate(s, r);
    results.push({ id: s.id, risk_class: s.risk_class, ...verdict });
    console.log(`${verdict.verdict}  ${s.id}${verdict.fail.length ? ' :: ' + verdict.fail.join('; ') : ''}`);
  }

  await Promise.all(cleanup.map((srv) => new Promise((r) => srv.close(r))));

  const counts = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  const verdictDoc = {
    schema: 'lume-frontier-verdict/1.0',
    generated: new Date().toISOString(),
    mode: selfTest ? 'self-test' : 'target',
    target: targetBase,
    sabotaged: [...sabotage],
    counts,
    results
  };
  console.log(JSON.stringify(verdictDoc, null, 2));

  const pass = (counts.PASS || 0) === results.length;
  if (pass) process.exit(0);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
