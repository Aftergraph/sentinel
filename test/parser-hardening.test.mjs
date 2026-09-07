// Parser hardening: adversarial fixtures for the mini-YAML policy parser,
// the unified-diff parser, and globToRegExp. Every case asserts either a
// clean fail-closed throw (message match) or an exact structured result —
// no silent misparses. Fixtures are inline strings (no fixture dirs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy } from '../lib/policy.js';
import { parseDiff } from '../lib/rules/_diff-parse.js';
import { globToRegExp, summarizeDiff } from '../lib/review.js';

const HAPPY = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: web-strict
spec:
  scope:
    repo: acme/web
    paths:
      - "src/**"
  required:
    - sast
    - dast
  blocking_severity:
    - security
    - reliability
  approvals:
    required:
      - alice
`;

const MINIMAL = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: n
spec:
  scope:
    paths: []
  required: []
  blocking_severity:
    - security
  approvals:
    required: []
`;

// ---------------------------------------------------------------------------
// policy parser
// ---------------------------------------------------------------------------

test('policy: leading-tab indentation is rejected', () => {
  assert.throws(() => parsePolicy(HAPPY.replace('  name:', '\tname:')), /tabs not allowed/);
});

test('policy: tab-indented list item is rejected', () => {
  assert.throws(() => parsePolicy(HAPPY.replace('    - sast', '\t- sast')), /tabs not allowed/);
});

test('policy: tab after the key colon parses to the same value as a space (no misparse)', () => {
  const tabbed = parsePolicy(HAPPY.replace('name: web-strict', 'name:\tweb-strict'));
  assert.equal(tabbed.metadata.name, parsePolicy(HAPPY).metadata.name);
});

test('policy: CRLF line endings parse identically to LF', () => {
  assert.deepEqual(parsePolicy(HAPPY.replaceAll('\n', '\r\n')), parsePolicy(HAPPY));
});

test('policy: CR-only line endings fail closed', () => {
  assert.throws(() => parsePolicy(HAPPY.replaceAll('\n', '\r')), /Invalid policy/);
});

test('policy: 80-level deep nesting fails closed without a crash', () => {
  let yaml = MINIMAL.replace('  approvals:\n    required: []\n', '  approvals:\n    required: []\n  deep:\n');
  let indent = '    ';
  for (let i = 0; i < 80; i++) {
    yaml += `${indent}k${i}:\n`;
    indent += '  ';
  }
  yaml += `${indent}leaf: 1\n`;
  assert.throws(() => parsePolicy(yaml), /Invalid policy/);
});

test('policy: duplicate keys at different levels coexist (spec.required vs approvals.required)', () => {
  const p = parsePolicy(HAPPY);
  assert.deepEqual(p.spec.required, ['sast', 'dast']);
  assert.deepEqual(p.spec.approvals.required, ['alice']);
});

test('policy: duplicate key in the same map throws (top level)', () => {
  assert.throws(() => parsePolicy(`${HAPPY}spec: {}\n`), /duplicate key "spec"/);
});

test('policy: duplicate key in the same nested map throws', () => {
  assert.throws(() => parsePolicy(HAPPY.replace('  name: web-strict\n', '  name: a\n  name: b\n')), /duplicate key "name"/);
});

test('policy: empty, whitespace-only, and comment-only documents fail closed', () => {
  assert.throws(() => parsePolicy(''), /non-empty string/);
  assert.throws(() => parsePolicy('   \n  \n'), /non-empty string/);
  assert.throws(() => parsePolicy('# just a comment\n# another\n'), /empty document/);
});

test('policy: non-string scalars fail closed', () => {
  assert.throws(() => parsePolicy(HAPPY.replace('name: web-strict', 'name: 123')), /metadata\.name.*non-empty string/);
  assert.throws(() => parsePolicy(HAPPY.replace('name: web-strict', 'name: true')), /metadata\.name.*non-empty string/);
  assert.throws(
    () => parsePolicy(MINIMAL.replace('    paths: []', '    repo: 123\n    paths: []')),
    /spec\.scope\.repo.*non-empty string/,
  );
  assert.throws(
    () => parsePolicy(MINIMAL.replace('  required: []', '  required:\n    - 5')),
    /spec\.required.*non-empty strings/,
  );
});

test('policy: null scalar — empty repo means org-wide, empty name throws', () => {
  const p = parsePolicy(MINIMAL.replace('    paths: []', '    repo:\n    paths: []'));
  assert.deepEqual(p.spec.scope, { repo: null, paths: [] });
  assert.throws(() => parsePolicy(MINIMAL.replace('  name: n', '  name:')), /metadata\.name.*non-empty string/);
});

test('policy: unicode values preserved exactly; unicode keys fail closed', () => {
  const p = parsePolicy(MINIMAL.replace('  name: n', '  name: wéb-stríct✓'));
  assert.equal(p.metadata.name, 'wéb-stríct✓');
  const q = parsePolicy(MINIMAL.replace('  required: []', '  required:\n    - säst-✓'));
  assert.deepEqual(q.spec.required, ['säst-✓']);
  assert.throws(
    () => parsePolicy(MINIMAL.replace('  required: []', '  required: []\n  café: x')),
    /unknown spec key "café"/,
  );
  assert.throws(
    () => parsePolicy(MINIMAL.replace('    paths: []', '    paths: []\n    café: x')),
    /unknown spec\.scope key "café"/,
  );
});

test('policy: 10KB single line parses exactly', () => {
  const big = 'x'.repeat(10240);
  const line = `  name: ${big}\n`;
  assert.ok(line.length > 10240, 'fixture is a >10KB single line');
  assert.equal(parsePolicy(MINIMAL.replace('  name: n\n', line)).metadata.name, big);
});

test('policy: inline flow collections and lists of maps are rejected', () => {
  assert.throws(() => parsePolicy(MINIMAL.replace('    paths: []', '    paths: [a]')), /bad scalar/);
  assert.throws(
    () => parsePolicy(HAPPY.replace('    - sast', '    - a: b')),
    /lists of maps are not supported/,
  );
});

test('policy: trailing comments stripped, quoted hashes preserved', () => {
  const p = parsePolicy(MINIMAL.replace('  name: n', '  name: "a#b" # trailing'));
  assert.equal(p.metadata.name, 'a#b');
});

// ---------------------------------------------------------------------------
// diff parser
// ---------------------------------------------------------------------------

test('diff: empty diff yields no files', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff('\n'), []);
});

test('diff: malformed hunk header leaves the line counter untouched (exact)', () => {
  const files = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -x,y +z,w @@\n+hi\n-old\n');
  assert.deepEqual(files, [{ path: 'a.js', hunks: [], addedLines: [{ line: 0, text: 'hi' }], removedCount: 1 }]);
});

test('diff: negative-number hunk header is not a hunk (exact)', () => {
  const files = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ --1,2 ++1,2 @@\n+hi\n-old\n');
  assert.deepEqual(files, [{ path: 'a.js', hunks: [], addedLines: [{ line: 0, text: 'hi' }], removedCount: 1 }]);
});

test('diff: hunk header without counts parses (exact)', () => {
  const files = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n+hi\n');
  assert.deepEqual(files, [{ path: 'a.js', hunks: [], addedLines: [{ line: 1, text: 'hi' }], removedCount: 0 }]);
});

test('diff: /dev/null on both sides yields no files', () => {
  assert.deepEqual(parseDiff('--- /dev/null\n+++ /dev/null\n@@ -0,0 +0,0 @@\n'), []);
});

test('diff: deleted file keeps its path and removed count (was silently dropped)', () => {
  const files = parseDiff('diff --git a/foo.js b/foo.js\ndeleted file mode 100644\n--- a/foo.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-foo\n-bar\n');
  assert.deepEqual(files, [{ path: 'foo.js', hunks: [], addedLines: [], removedCount: 2 }]);
  const summary = summarizeDiff('diff --git a/foo.js b/foo.js\ndeleted file mode 100644\n--- a/foo.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-foo\n-bar\n');
  assert.deepEqual(summary, { files: 1, added: 0, removed: 2, top: [{ path: 'foo.js', added: 0, removed: 2 }] });
});

test('diff: new file from /dev/null parses (exact)', () => {
  const files = parseDiff('diff --git a/x.js b/x.js\nnew file mode 100644\n--- /dev/null\n+++ b/x.js\n@@ -0,0 +1 @@\n+hi\n');
  assert.deepEqual(files, [{ path: 'x.js', hunks: [], addedLines: [{ line: 1, text: 'hi' }], removedCount: 0 }]);
});

test('diff: rename with similarity attributes hunks to the new path (exact)', () => {
  const files = parseDiff('diff --git a/old.js b/new.js\nsimilarity index 90%\nrename from old.js\nrename to new.js\n--- a/old.js\n+++ b/new.js\n@@ -1 +1 @@\n-old\n+new\n');
  assert.deepEqual(files, [{ path: 'new.js', hunks: [], addedLines: [{ line: 1, text: 'new' }], removedCount: 1 }]);
});

test('diff: binary diffs and mode-only changes yield no files', () => {
  assert.deepEqual(parseDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n'), []);
  assert.deepEqual(parseDiff('diff --git a/f.js b/f.js\nold mode 100644\nnew mode 100755\n'), []);
});

test('diff: huge line numbers preserved exactly', () => {
  const files = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +4294967296 @@\n+hi\n');
  assert.deepEqual(files, [{ path: 'a.js', hunks: [], addedLines: [{ line: 4294967296, text: 'hi' }], removedCount: 0 }]);
});

test('diff: NUL bytes preserved exactly without a crash', () => {
  const files = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n+hi\0there\n');
  assert.deepEqual(files, [{ path: 'a.js', hunks: [], addedLines: [{ line: 1, text: 'hi\0there' }], removedCount: 0 }]);
});

test('diff: no-newline marker ignored, counts exact', () => {
  const files = parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n\\ No newline at end of file\n');
  assert.deepEqual(files, [{ path: 'a.js', hunks: [], addedLines: [{ line: 2, text: 'new' }], removedCount: 1 }]);
});

test('diff: CRLF endings do not leak CR into paths or text (was silently skipped by rules)', () => {
  const files = parseDiff('diff --git a/a.js b/a.js\r\n--- a/a.js\r\n+++ b/a.js\r\n@@ -1 +1 @@\r\n+hi\r\n');
  assert.deepEqual(files, [{ path: 'a.js', hunks: [], addedLines: [{ line: 1, text: 'hi' }], removedCount: 0 }]);
});

// ---------------------------------------------------------------------------
// globToRegExp (lib/review.js): ** spans segments, braces are literal
// ---------------------------------------------------------------------------

test('glob: *, **, and ? segment semantics', () => {
  assert.equal(globToRegExp('*.js').test('a.js'), true);
  assert.equal(globToRegExp('*.js').test('a/b.js'), false);
  assert.equal(globToRegExp('src/**').test('src/a/b.js'), true);
  assert.equal(globToRegExp('**/*.js').test('a/b/c.js'), true);
  assert.equal(globToRegExp('a?.js').test('ab.js'), true);
  assert.equal(globToRegExp('a?.js').test('a/b.js'), false);
});

test('glob: regex metacharacters are escaped', () => {
  assert.equal(globToRegExp('file+.js').test('file+.js'), true);
  assert.equal(globToRegExp('file+.js').test('filexjs'), false);
  assert.equal(globToRegExp('a(b).js').test('a(b).js'), true);
  assert.equal(globToRegExp('a(b).js').test('axb.js'), false);
  assert.equal(globToRegExp('src/app.js').test('srcXapp.js'), false);
  assert.equal(globToRegExp('file[1].js').test('file[1].js'), true);
  assert.equal(globToRegExp('file[1].js').test('file1.js'), false);
});

test('glob: braces are unsupported and match literally (documented)', () => {
  // No brace expansion: the pattern matches only the literal `{a,b}` path.
  assert.equal(globToRegExp('src/{a,b}.js').test('src/{a,b}.js'), true);
  assert.equal(globToRegExp('src/{a,b}.js').test('src/a.js'), false);
  assert.equal(globToRegExp('src/{a,b}.js').test('src/b.js'), false);
});

test('glob: backslashes match literally', () => {
  assert.equal(globToRegExp('a\\b').test('a\\b'), true);
  assert.equal(globToRegExp('a\\b').test('ab'), false);
  assert.equal(globToRegExp('a\\*').test('a\\xyz'), true);
  assert.equal(globToRegExp('a\\*').test('axyz'), false);
});
