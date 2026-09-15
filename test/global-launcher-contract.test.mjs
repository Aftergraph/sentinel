import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../console/public/index.html', import.meta.url), 'utf8');

test('Sentinel Console exposes the canonical Aftergraph Launcher', () => {
  assert.match(html, /href="https:\/\/aftergraph\.org\/launch"/);
  assert.match(html, />Launcher<\/a>/);
  assert.match(html, /aria-label="Aftergraph Launcher"/);
});

test('Sentinel Launcher entry is external to local hash navigation', () => {
  const match = html.match(/<a[^>]+href="https:\/\/aftergraph\.org\/launch"[^>]*>Launcher<\/a>/);
  assert.ok(match);
  assert.doesNotMatch(match[0], /data-nav=/);
});
