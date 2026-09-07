// Context graph MVP tests — synthetic repos, no disk fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModule, resolveImport, buildGraph, blastRadius, enclosingSymbol,
  buildRepoGraph, resolveRepoFile,
} from '../lib/context-graph.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'sentinel.js');

const A = `import { b } from './b.js';
import fs from 'node:fs';
// function ghost() {}
export function alpha() {
  return b() + helper();
}
const helper = () => 1;
export class Keeper {}
export { alpha as beta };
if (ok) { run(alpha); }
`;

test('context: parseModule finds symbols, imports, calls; skips comments', () => {
  const m = parseModule('src/a.js', A);
  const names = Object.fromEntries(m.symbols.map((s) => [s.name, s]));
  assert.equal(names.alpha.kind, 'function');
  assert.equal(names.alpha.exported, true);
  assert.equal(names.helper.kind, 'binding');
  assert.equal(names.Keeper.kind, 'class');
  assert.ok(!names.ghost, 'commented symbol must not parse');
  assert.deepEqual(m.imports.map((i) => i.from), ['./b.js', 'node:fs']);
  const called = m.calls.map((c) => c.name);
  assert.ok(called.includes('b') && called.includes('helper') && called.includes('run'));
  assert.ok(!called.includes('if'), 'keywords are not calls');
});

test('context: resolveImport is relative-only with injected existence', () => {
  const has = (p) => new Set(['src/b.js', 'src/util/index.ts', 'lib/x.mjs']).has(p);
  assert.equal(resolveImport('src/a.js', './b', has), 'src/b.js');
  assert.equal(resolveImport('src/a.js', './b.js', has), 'src/b.js');
  assert.equal(resolveImport('src/deep/a.js', '../util', has), 'src/util/index.ts');
  assert.equal(resolveImport('src/a.js', './missing', has), null);
  assert.equal(resolveImport('src/a.js', 'lodash', has), null);
  assert.equal(resolveImport('src/a.js', 'node:fs', has), null);
});

test('context: buildGraph resolves edges, marks externals, skips non-JS', () => {
  const g = buildGraph([
    { path: 'src/a.js', text: `import { b } from './b.js';\nimport _ from 'lodash';\n` },
    { path: 'src/b.js', text: `export function b() {}\n` },
    { path: 'README.md', text: `import x from './x.js';\n` },
  ]);
  assert.deepEqual(g.edges, [{ from: 'src/a.js', to: 'src/b.js', line: 1 }]);
  assert.equal(g.files['src/a.js'].imports[1].external, true);
  assert.ok(!g.files['README.md'], 'non-JS skipped');
});

test('context: blastRadius walks transitive importers and terminates cycles', () => {
  const g = buildGraph([
    { path: 'c.js', text: `import { b } from './b.js';\nexport const c = b();\n` },
    { path: 'b.js', text: `import { a } from './a.js';\nexport const b = () => a();\n` },
    { path: 'a.js', text: `export function a() { return 1; }\n` },
    { path: 'loop1.js', text: `import './loop2.js';\n` },
    { path: 'loop2.js', text: `import './loop1.js';\n` },
    { path: 'far.js', text: `export function far() {}\n` },
  ]);
  const r = blastRadius(g, { file: 'a.js', symbol: 'a' });
  assert.deepEqual(r.files, ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(r.symbols, [{ file: 'a.js', name: 'a' }]);
  const loop = blastRadius(g, { file: 'loop1.js' });
  assert.deepEqual(loop.files, ['loop1.js', 'loop2.js']);
  assert.deepEqual(blastRadius(g, { file: 'nope.js' }), { files: [], symbols: [] });
});

test('context: buildRepoGraph walks a checkout, skips vendors, caps safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-graph-repo-'));
  try {
    writeFileSync(join(dir, 'a.js'), `import { b } from './b.js';\nexport const a = b();\n`);
    writeFileSync(join(dir, 'b.js'), `export function b() { return 1; }\n`);
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), `export const x = 1;\n`);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks.js'), `export const y = 1;\n`);
    const g = buildRepoGraph({ repoDir: dir });
    assert.deepEqual(Object.keys(g.files).sort(), ['a.js', 'b.js']);
    assert.equal(g.stats.truncated, false);
    const r = blastRadius(g, { file: 'b.js', symbol: 'b' });
    assert.deepEqual(r.files, ['a.js', 'b.js']);
    assert.throws(() => buildRepoGraph({ repoDir: join(dir, 'missing') }), /not found/);
    assert.throws(() => buildRepoGraph({ repoDir: join(dir, 'a.js') }), /not a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context: require/dynamic-import lines terminate with correct imports', () => {
  const m = parseModule('src/c.cjs', `const a = require('./a.js');\nconst b = await import('./b.js');\nmodule.exports = { a, b };\n`);
  assert.deepEqual(m.imports.map((i) => [i.from, i.kind]), [['./a.js', 'require'], ['./b.js', 'dynamic']]);
});

test('context: resolveRepoFile rejects escapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-graph-esc-'));
  try {
    assert.equal(resolveRepoFile(dir, 'sub/../a.js'), 'a.js');
    assert.throws(() => resolveRepoFile(dir, '../outside.js'), /inside repo dir/);
    assert.throws(() => resolveRepoFile(dir, ''), /inside repo dir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context: CLI blast-radius exits 0 with files, 1 on bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-graph-cli-'));
  try {
    writeFileSync(join(dir, 'a.js'), `import { b } from './b.js';\nexport const a = b();\n`);
    writeFileSync(join(dir, 'b.js'), `export function b() { return 1; }\n`);
    const ok = spawnSync('node', [BIN, 'context', 'blast-radius', '--repo-dir', dir, '--file', 'b.js', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.deepEqual(JSON.parse(ok.stdout).files, ['a.js', 'b.js']);
    const bad = spawnSync('node', [BIN, 'context', 'blast-radius', '--repo-dir', dir], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    const esc = spawnSync('node', [BIN, 'context', 'blast-radius', '--repo-dir', dir, '--file', '../x.js'], { encoding: 'utf8' });
    assert.equal(esc.status, 1);
    assert.match(esc.stderr, /inside repo dir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context: blastRadius maps line to enclosing symbol and finds callers', () => {
  const g = buildGraph([
    { path: 'lib.js', text: `export function target() {\n  return 1;\n}\nexport function other() {}\n` },
    { path: 'use.js', text: `import { target } from './lib.js';\nconst v = target();\n` },
  ]);
  assert.equal(enclosingSymbol(g.files['lib.js'].symbols, 2).name, 'target');
  const r = blastRadius(g, { file: 'lib.js', line: 2 });
  assert.deepEqual(r.symbols, [{ file: 'lib.js', name: 'target' }]);
  assert.ok(r.files.includes('use.js'), 'caller file included');
});

// ---- Python (S2 slice 3) ----

const PY_MOD = `"""Module docstring mentioning import os trap."""
import os, sys as system
import pkg.util as util; import json
from refunds import calc_total, fmt as format_amount
from refunds import (validate,
    authorize)
from . import sibling
from .helpers import assist
from ..core import engine
from pkg import *
import logging  # trailing comment
try:
    import ujson as json_fast
except ImportError:
    json_fast = None
if TYPE_CHECKING:
    from typing import Protocol
if sys.version_info >= (3, 9):
    from zoneinfo import ZoneInfo
mod = __import__("dynmod")
mod2 = importlib.import_module("dynmod2")
mod3 = importlib.import_module(name_var)
"""Closing docstring mentioning from x import y trap."""
VALUE = 42
async def refund(order):
    return calc_total(order)
class Processor:
    def run(self):
        return assist(order)
def _private():
    pass
@decorator(arg)
def decorated():
    pass
result = refund(order1) + unknown_fn()
`;

test('context-py: static import forms parse with line numbers', () => {
  const m = parseModule('pkg/api.py', PY_MOD);
  const by = Object.fromEntries(m.imports.map((i) => [`${i.from}@${i.line}`, i]));
  assert.equal(by['os@2'].kind, 'static');
  assert.equal(by['sys@2'].kind, 'static');
  assert.equal(by['pkg.util@3'].kind, 'static');
  assert.equal(by['json@3'].kind, 'static');
  assert.equal(by['logging@11'].kind, 'static');
});

test('context-py: from-forms parse (plain, paren, alias, star)', () => {
  const m = parseModule('pkg/api.py', PY_MOD);
  const froms = m.imports.filter((i) => i.from === 'refunds');
  assert.equal(froms.length, 2, 'two refunds imports (plain + paren-joined)');
  assert.ok(froms.every((i) => i.kind === 'static'));
  const star = m.imports.find((i) => i.from === 'pkg');
  assert.ok(star, 'star import records the package');
});

test('context-py: relative levels parse with dot counts', () => {
  const m = parseModule('pkg/api.py', PY_MOD);
  const rel = Object.fromEntries(m.imports.filter((i) => i.level > 0).map((i) => [i.from, i]));
  assert.equal(rel['.sibling'].level, 1);
  assert.equal(rel['.helpers'].level, 1);
  assert.equal(rel['..core'].level, 2);
});

test('context-py: conditional imports flagged, never pruned', () => {
  const m = parseModule('pkg/api.py', PY_MOD);
  const by = Object.fromEntries(m.imports.map((i) => [i.from, i]));
  assert.equal(by['ujson'].kind, 'conditional', 'try/except ImportError');
  assert.equal(by['typing'].kind, 'conditional', 'TYPE_CHECKING');
  assert.equal(by['zoneinfo'].kind, 'conditional', 'version guard');
  assert.ok(by['ujson'] && by['typing'] && by['zoneinfo'], 'conditionals recorded');
});

test('context-py: dynamic imports need string literals', () => {
  const m = parseModule('pkg/api.py', PY_MOD);
  const dyn = m.imports.filter((i) => i.kind === 'dynamic').map((i) => i.from).sort();
  assert.deepEqual(dyn, ['dynmod', 'dynmod2']);
});

test('context-py: docstrings and comments are not code', () => {
  const m = parseModule('pkg/api.py', PY_MOD);
  const froms = m.imports.map((i) => i.from);
  assert.equal(froms.filter((f) => f === 'os').length, 1, 'docstring trap must not double-count');
  assert.ok(!m.calls.some((c) => c.name === 'trap'), 'no calls from docstrings');
});

test('context-py: symbols cover def/async/class/nested/assignment', () => {
  const m = parseModule('pkg/api.py', PY_MOD);
  const by = Object.fromEntries(m.symbols.map((s) => [s.name, s]));
  assert.equal(by['refund'].kind, 'function');
  assert.equal(by['Processor'].kind, 'class');
  assert.equal(by['run'].kind, 'function', 'nested def attributed to file');
  assert.equal(by['VALUE'].kind, 'binding');
  assert.equal(by['decorated'].kind, 'function');
  assert.equal(by['_private'].kind, 'function');
});

test('context-py: calls exclude keywords, decorators, definitions', () => {
  const m = parseModule('pkg/api.py', PY_MOD);
  const called = m.calls.map((c) => c.name);
  for (const want of ['calc_total', 'assist', 'refund', 'unknown_fn']) {
    assert.ok(called.includes(want), `missing call ${want}`);
  }
  for (const no of ['if', 'import', 'from', 'def', '__import__', 'import_module', 'decorator', 'arg']) {
    assert.ok(!called.includes(no), `must not record ${no}`);
  }
});

test('context-py: resolveImport matrix (relative/init/absolute/stdlib)', () => {
  const has = (p) => ['pkg/b.py', 'pkg/__init__.py', 'pkg/sub/c.py'].includes(p);
  const R = (f, s) => resolveImport(f, s, has);
  assert.equal(R('pkg/a.py', '.b'), 'pkg/b.py');
  assert.equal(R('pkg/sub/c.py', '..b'), 'pkg/b.py', 'level 2 ascends once');
  assert.equal(R('pkg/a.py', '.'), 'pkg/__init__.py', 'bare dot resolves package init');
  assert.equal(R('pkg/a.py', 'os'), null, 'absolute never resolved');
  assert.equal(R('pkg/a.py', 'sys'), null, 'stdlib never resolved');
  assert.equal(R('pkg/a.py', '.missing'), null, 'unknown relative is null, not guessed');
});

test('context-py: buildGraph mixes languages, emits zero cross edges', () => {
  const g = buildGraph([
    { path: 'pkg/a.py', text: `from . import b\nx = 1\n` },
    { path: 'pkg/b.py', text: `VALUE = 1\n` },
    { path: 'main.js', text: `import x from './x.js';\n` },
    { path: 'note.txt', text: `from . import b\n` },
  ], { hasFile: (p) => ['pkg/a.py', 'pkg/b.py', 'main.js'].includes(p) });
  assert.ok(g.files['pkg/a.py'] && g.files['pkg/b.py'] && g.files['main.js']);
  assert.ok(!g.files['note.txt'], 'non-code entries skipped');
  assert.ok(g.edges.some((e) => e.from === 'pkg/a.py' && e.to === 'pkg/b.py'));
  const cross = g.edges.filter((e) => e.from.endsWith('.js') !== e.to.endsWith('.js'));
  assert.deepEqual(cross, [], 'no JS<->Python edge may ever resolve');
});

test('context-py: blastRadius covers importers and name-callers', () => {
  const g = buildGraph([
    { path: 'pkg/a.py', text: `from .b import thing\nx = thing()\n` },
    { path: 'pkg/b.py', text: `def thing():\n return 1\n` },
  ], { hasFile: (p) => ['pkg/a.py', 'pkg/b.py'].includes(p) });
  const r = blastRadius(g, { file: 'pkg/b.py', symbol: 'thing' });
  assert.deepEqual(r.files, ['pkg/a.py', 'pkg/b.py']);
  assert.deepEqual(r.symbols, [{ file: 'pkg/b.py', name: 'thing' }]);
});

test('context-py: blastRadius terminates on import cycles', () => {
  const g = buildGraph([
    { path: 'pkg/c1.py', text: `from . import c2\n` },
    { path: 'pkg/c2.py', text: `from . import c1\n` },
  ], { hasFile: (p) => ['pkg/c1.py', 'pkg/c2.py'].includes(p) });
  const r = blastRadius(g, { file: 'pkg/c1.py' });
  assert.deepEqual(r.files, ['pkg/c1.py', 'pkg/c2.py']);
});

test('context-py: buildRepoGraph walks .py, skips envs/caches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-graph-py-'));
  try {
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'pkg', '__pycache__'), { recursive: true });
    mkdirSync(join(dir, '.venv', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'venv'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'a.py'), `from . import b\n`);
    writeFileSync(join(dir, 'pkg', 'b.py'), `VALUE = 1\n`);
    writeFileSync(join(dir, 'pkg', '__pycache__', 'b.pyc'), 'junk');
    writeFileSync(join(dir, '.venv', 'lib', 'x.py'), `import os\n`);
    writeFileSync(join(dir, 'venv', 'y.py'), `import os\n`);
    writeFileSync(join(dir, 'main.js'), `export const m = 1;\n`);
    const g = buildRepoGraph({ repoDir: dir });
    assert.deepEqual(Object.keys(g.files).sort(), ['main.js', 'pkg/a.py', 'pkg/b.py']);
    assert.deepEqual(g.stats, {
      repoDir: g.stats.repoDir, scanned: 3, skipped: 3, truncated: false, maxFiles: 500,
    });
    assert.ok(g.edges.some((e) => e.from === 'pkg/a.py' && e.to === 'pkg/b.py'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-py: CLI blast-radius works on Python files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-graph-pycli-'));
  try {
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'a.py'), `from .b import thing\nx = thing()\n`);
    writeFileSync(join(dir, 'pkg', 'b.py'), `def thing():\n return 1\n`);
    const human = spawnSync('node', [BIN, 'context', 'blast-radius', '--repo-dir', dir, '--file', 'pkg/b.py', '--symbol', 'thing'], { encoding: 'utf8' });
    assert.equal(human.status, 0);
    assert.match(human.stdout, /pkg\/a\.py/);
    const json = spawnSync('node', [BIN, 'context', 'blast-radius', '--repo-dir', dir, '--file', 'pkg/b.py', '--format', 'json'], { encoding: 'utf8' });
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout).files, ['pkg/a.py', 'pkg/b.py']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-py: enclosingSymbol maps Python lines', () => {
  const m = parseModule('pkg/b.py', `VALUE = 1\ndef thing():\n return 1\n`);
  assert.equal(enclosingSymbol(m.symbols, 3).name, 'thing');
});

test('context-py: blast output is deterministic', () => {
  const entries = [
    { path: 'pkg/a.py', text: `from .b import thing\nx = thing()\n` },
    { path: 'pkg/b.py', text: `def thing():\n return 1\n` },
  ];
  const has = (p) => ['pkg/a.py', 'pkg/b.py'].includes(p);
  const r1 = blastRadius(buildGraph(entries, { hasFile: has }), { file: 'pkg/b.py', symbol: 'thing' });
  const r2 = blastRadius(buildGraph(entries, { hasFile: has }), { file: 'pkg/b.py', symbol: 'thing' });
  assert.deepEqual(r1, r2);
});

test('context-py: graph stays out of verdict paths (contract grep)', () => {
  // review.js may import the graph for ADVISORY context only; the hash and
  // policy paths must never touch it. The strip guard in receipt.js is the
  // mechanism that keeps blastContext out of receipt_id (pinned here so no
  // edit can silently drop it while review.js still imports the graph).
  for (const f of ['lib/receipt.js', 'lib/policy.js']) {
    const src = readFileSync(join(HERE, '..', f), 'utf8');
    assert.ok(!src.includes('context-graph'), `${f} must never import the graph`);
  }
  const receiptSrc = readFileSync(join(HERE, '..', 'lib', 'receipt.js'), 'utf8');
  assert.ok(receiptSrc.includes('stripBlastContext'), 'receipt strip guard must exist');
  const reviewSrc = readFileSync(join(HERE, '..', 'lib', 'review.js'), 'utf8');
  assert.ok(reviewSrc.includes('advisory'), 'review graph use must stay labeled advisory');
});

test('context-py: import line numbers pin to statement starts', () => {
  const m = parseModule('a.py', `import os\nfrom x import (a,\n  b)\n`);
  const by = Object.fromEntries(m.imports.map((i) => [i.from, i]));
  assert.equal(by['os'].line, 1);
  assert.equal(by['x'].line, 2, 'paren-joined import pins to first line');
});
