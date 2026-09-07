// Context graph MVP (S2 slice 1, Python in S2 slice 3) — deterministic
// JS/TS + Python symbol + import + call-reference graph over exact file
// contents, powering blast-radius queries ("what does this finding
// touch?").
//
// Scope is deliberately narrow (precision over recall, same bar as the
// rule pack): top-level symbols only (methods and nested defs attribute
// to their file, not their class); relative imports only (bare
// specifiers, node: builtins and stdlib names are recorded as external,
// never resolved); full-line comments and docstrings are not code. No
// AST, no types, no control flow: a `name(` token outside a comment is
// a call reference, even inside strings — over-approximation is
// documented, callers decide. Python import kinds: static, conditional
// (try/except ImportError, TYPE_CHECKING, version guards — recorded,
// never pruned), dynamic (string-literal __import__/import_module only).
//
// Pure: all functions take text/maps, touch no filesystem. The caller
// reads files and injects existence via `hasFile` so tests pin behavior
// without fixtures on disk. All outputs are JSON-serializable.
//
// Contract:
//   parseModule(path, text) -> { path, symbols, imports, calls }
//     (.py paths use the Python parser; same output shape; import kind
//     in static|require|dynamic|conditional)
//   resolveImport(fromPath, spec, hasFile) -> resolved path | null
//     (leading-dot specs in .py files resolve with package semantics:
//     level = dot count, candidates mod.py and mod/__init__.py)
//   buildGraph([{ path, text }], { hasFile }) -> { files, edges }
//     (mixed JS+Python; cross-language edges are never emitted)
//   blastRadius(graph, { file, symbol?, line? }) -> { files, symbols }
//   enclosingSymbol(symbols, line) -> symbol | null
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const JS_PATH_RE = /\.(m?js|cjs|ts|mts|cts|jsx|tsx)$/;
const PY_PATH_RE = /\.py$/;

function isCodePath(p) {
  return JS_PATH_RE.test(p) || PY_PATH_RE.test(p);
}

function isComment(t) {
  const s = t.trim();
  return s === '' || s.startsWith('//') || s.startsWith('*') || s.startsWith('#') || s.startsWith('<!--');
}

// Top-level symbol definitions. Each pattern captures the bound name;
// `export` prefix is optional and recorded separately.
const SYMBOL_RES = [
  [/^\s*export\s+default\s+function\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, 'binding'],
];

const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}/;
const IMPORT_FROM_RE = /^\s*import\s+(?:[^'"]*?\s+from\s+)?(['"])((?:\\\1|(?!\1).)+)\1/;
const EXPORT_FROM_RE = /^\s*export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s+(['"])((?:\\\1|(?!\1).)+)\1/;
const REQUIRE_RE = /(?:^|[^\w$.])require\s*\(\s*(['"])((?:\\\1|(?!\1).)+)\1\s*\)/g;
const DYNAMIC_IMPORT_RE = /(?:^|[^\w$.])import\s*\(\s*(['"])((?:\\\1|(?!\1).)+)\1\s*\)/g;
// A call reference: identifier directly followed by `(`. Excludes method
// definitions (`name() {`), keywords, and member access (`obj.name(` still
// attributes to `name` — documented over-approximation).
const CALL_RE = /(?:^|[^\w$.])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
const CALL_DEF_RE = /^\s*(?:export\s+)?(?:async\s+|static\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'new', 'delete', 'void', 'in', 'of', 'instanceof', 'await', 'yield',
  'import', 'export', 'default', 'class', 'extends', 'super', 'this',
  'try', 'finally', 'do', 'else', 'case', 'throw', 'with', 'debugger',
]);

const CANDIDATE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];
const PY_CANDIDATE_SUFFIXES = ['.py', '/__init__.py'];

// ---- Python (regex-level, same bar as the JS side) ----

const PY_DEF_RE = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const PY_CLASS_RE = /^\s*class\s+([A-Za-z_]\w*)\s*[\(:]/;
const PY_ASSIGN_RE = /^([A-Za-z_]\w*)\s*=/;
const PY_IMPORT_RE = /^\s*import\s+(.+)$/;
const PY_FROM_RE = /^\s*from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+(.+)$/;
const PY_DYNAMIC_RE = /(?:^|[^\w$.])(?:__import__|importlib\s*\.\s*import_module)\s*\(\s*(['"])((?:\\\1|(?!\1).)+)\1\s*\)/g;
const PY_CALL_RE = /(?:^|[^\w$.])([A-Za-z_]\w*)\s*\(/g;
const PY_KEYWORDS = new Set([
  'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'import',
  'from', 'with', 'as', 'pass', 'raise', 'assert', 'del', 'lambda', 'in',
  'is', 'not', 'and', 'or', 'try', 'except', 'finally', 'yield', 'await',
  '__import__', 'import_module',
]);
// Block openers whose suite makes an import conditional (fallback-prone):
// try/except/finally suites plus static-analysis and version guards.
const PY_COND_OPENER_RE = /^\s*(try|except\b|finally\b|if\s+.*TYPE_CHECKING|elif\s+.*TYPE_CHECKING|if\s+.*version_info)\b/;
// Single-line conditional import: `if TYPE_CHECKING: import x`.
const PY_COND_ONELINER_RE = /^\s*if\s+.*(?:TYPE_CHECKING|version_info).*:\s*(?:import|from)\b/;
const PY_BLOCK_OPENER_RE = /:\s*(#.*)?$/;

function pyIndentOf(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

// Join backslash continuations and strip docstring spans. Returns
// [{ text, line }] pinned to the first physical line. Triple-quoted
// spans across lines are skipped; `"""one-liners"""` are blanked.
function pyLogicalLines(text) {
  const out = [];
  const raw = String(text ?? '').split('\n');
  let inDoc = null;
  let buf = null;
  const pushBuf = () => { if (buf) { out.push(buf); buf = null; } };
  raw.forEach((r, idx) => {
    const line = idx + 1;
    let s = r;
    if (inDoc) {
      const end = s.indexOf(inDoc);
      if (end === -1) return;
      s = s.slice(end + inDoc.length);
      inDoc = null;
    }
    s = s.replace(/"""[\s\S]*?"""/g, '').replace(/'''[\s\S]*?'''/g, '');
    const openD = s.indexOf('"""');
    const openS = s.indexOf("'''");
    if (openD !== -1 && (openS === -1 || openD < openS)) { inDoc = '"""'; s = s.slice(0, openD); }
    else if (openS !== -1) { inDoc = "'''"; s = s.slice(0, openS); }
    const noTrail = s.replace(/\s+$/, '');
    const continued = noTrail.endsWith('\\');
    if (continued) s = noTrail.slice(0, -1);
    if (buf) buf.text += ' ' + s.trim();
    else buf = { text: s, line };
    if (!continued) pushBuf();
  });
  pushBuf();
  return out;
}

function pySplitNames(listing) {
  let s = listing.trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  return s.split(',').map((part) => {
    const bits = part.trim().split(/\s+as\s+/);
    return (bits[0] || '').trim();
  }).filter((n) => /^[A-Za-z_*][\w*]*$/.test(n));
}

function pyLevelOf(dotted) {
  const m = dotted.match(/^(\.+)/);
  return m ? m[1].length : 0;
}

export function parsePythonModule(path, text) {
  const symbols = [];
  const imports = [];
  const calls = [];
  const condStack = [];
  for (const { text: raw, line } of pyLogicalLines(text)) {
    if (isComment(raw)) continue;
    // Inline `#` ends the statement (whitespace-prefixed only, so `#`
    // inside string literals survives — same over-approximation bar as
    // the JS `//` strip).
    const code = raw.replace(/\s+#.*$/, '');
    if (code.trim() === '') continue;
    const indent = pyIndentOf(code);
    while (condStack.length > 0 && condStack[condStack.length - 1].indent >= indent) condStack.pop();
    const underConditional = condStack.some((f) => f.conditional);
    if (PY_BLOCK_OPENER_RE.test(code)) {
      condStack.push({ indent, conditional: underConditional || PY_COND_OPENER_RE.test(code) });
    }
    const kind = (underConditional || PY_COND_ONELINER_RE.test(code)) ? 'conditional' : 'static';
    // `import a; import b` — semicolon-separated statements.
    for (const stmt of code.split(';')) {
      const im = stmt.match(PY_IMPORT_RE);
      if (im) {
        for (const part of im[1].split(',')) {
          const bits = part.trim().split(/\s+as\s+/);
          const name = (bits[0] || '').trim();
          if (/^[A-Za-z_][\w.]*$/.test(name)) imports.push({ from: name, line, kind });
        }
        continue;
      }
      const fr = stmt.match(PY_FROM_RE);
      if (fr) {
        const names = pySplitNames(fr[2]);
        const level = pyLevelOf(fr[1]);
        const rest = fr[1].slice(level);
        if (rest === '' && names.length > 0 && !names.includes('*')) {
          // `from . import a, b` — each name is a candidate submodule.
          for (const n of names) imports.push({ from: `${'.'.repeat(level)}${n}`, line, kind, level });
        } else {
          imports.push({ from: fr[1], line, kind, level });
        }
        continue;
      }
    }
    let dm;
    PY_DYNAMIC_RE.lastIndex = 0;
    while ((dm = PY_DYNAMIC_RE.exec(code)) !== null) {
      imports.push({ from: dm[2], line, kind: 'dynamic' });
      if (dm.index === PY_DYNAMIC_RE.lastIndex) PY_DYNAMIC_RE.lastIndex++;
    }
    const defM = code.match(PY_DEF_RE);
    if (defM) {
      symbols.push({ name: defM[1], kind: 'function', line, exported: false });
      continue;
    }
    const classM = code.match(PY_CLASS_RE);
    if (classM) {
      symbols.push({ name: classM[1], kind: 'class', line, exported: false });
      continue;
    }
    const assignM = indent === 0 ? code.match(PY_ASSIGN_RE) : null;
    if (assignM && !PY_KEYWORDS.has(assignM[1])) {
      symbols.push({ name: assignM[1], kind: 'binding', line, exported: false });
    }
    const trimmed = code.trim();
    // Decorators, import statements and definitions are not call sites.
    if (trimmed.startsWith('@') || trimmed.startsWith('import ') || trimmed.startsWith('from ')) continue;
    PY_CALL_RE.lastIndex = 0;
    let c;
    while ((c = PY_CALL_RE.exec(code)) !== null) {
      if (!PY_KEYWORDS.has(c[1])) calls.push({ name: c[1], line });
      if (c.index === PY_CALL_RE.lastIndex) PY_CALL_RE.lastIndex++;
    }
  }
  return { path, symbols, imports, calls };
}

// Filesystem walk (S2 integration). Skipped, never descended: node_modules,
// .git, Python envs/caches, hidden directories. Cap is fail-safe, not
// fail-closed: beyond maxFiles the walk stops and stats.truncated is true —
// callers surface it.
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv']);
const DEFAULT_MAX_FILES = 500;

function isSkippedDir(name) {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

function walkCodeFiles(repoDir, maxFiles) {
  const out = [];
  const skipped = [];
  let truncated = false;
  const stack = [repoDir];
  while (stack.length > 0) {
    if (out.length >= maxFiles) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push(dir);
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (isSkippedDir(e.name)) skipped.push(full);
        else stack.push(full);
      } else if (e.isFile() && isCodePath(e.name)) {
        out.push(full);
      }
    }
  }
  return { out, skipped, truncated };
}

// Build a graph for a real checkout. Paths in the graph are repo-relative
// (forward slashes). Throws fail-closed on missing/non-directory repoDir.
// `file` arguments elsewhere must resolve inside repoDir: resolveRepoFile
// normalizes and rejects `..` escapes (wave-16 traversal spirit — MCP and
// CLI run with caller privileges, but confusion is still a bug).
export function resolveRepoFile(repoDir, file) {
  const root = resolve(repoDir);
  const abs = resolve(root, String(file ?? ''));
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || resolve(root, rel) !== abs) {
    throw new Error(`Invalid file (must stay inside repo dir): ${String(file).slice(0, 80)}`);
  }
  return rel.split(sep).join('/');
}

export function buildRepoGraph({ repoDir, maxFiles = DEFAULT_MAX_FILES } = {}) {
  if (typeof repoDir !== 'string' || repoDir === '') {
    throw new Error('Invalid repoDir (expected non-empty string).');
  }
  const root = resolve(repoDir);
  let stat;
  try {
    stat = statSync(root);
  } catch {
    throw new Error(`Invalid repoDir (not found): ${repoDir.slice(0, 80)}`);
  }
  if (!stat.isDirectory()) throw new Error(`Invalid repoDir (not a directory): ${repoDir.slice(0, 80)}`);
  const { out, skipped, truncated } = walkCodeFiles(root, maxFiles);
  const entries = [];
  for (const full of out) {
    const rel = relative(root, full).split(sep).join('/');
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      skipped.push(full);
      continue;
    }
    entries.push({ path: rel, text });
  }
  const byPath = new Map(entries.map((e) => [e.path, true]));
  const graph = buildGraph(entries, { hasFile: (p) => byPath.has(p) });
  return {
    ...graph,
    stats: {
      repoDir: root, scanned: entries.length, skipped: skipped.length, truncated, maxFiles,
    },
  };
}

export function parseModule(path, text) {
  if (PY_PATH_RE.test(String(path || ''))) return parsePythonModule(path, text);
  const symbols = [];
  const imports = [];
  const calls = [];
  const exported = new Set();
  const lines = String(text ?? '').split('\n');
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    if (isComment(raw)) return;
    const code = raw.replace(/\/\/.*$/, '');
    let definedHere = null;
    for (const [re, kind] of SYMBOL_RES) {
      const m = code.match(re);
      if (m) {
        const exportedFlag = /^\s*export\b/.test(code);
        symbols.push({ name: m[1], kind, line, exported: exportedFlag });
        if (exportedFlag) exported.add(m[1]);
        definedHere = m[1];
        break;
      }
    }
    const expList = code.match(EXPORT_LIST_RE);
    if (expList) {
      for (const part of expList[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        const name = (bits[bits.length - 1] || '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) exported.add(name);
      }
    }
    const from = code.match(IMPORT_FROM_RE) || code.match(EXPORT_FROM_RE);
    if (from) imports.push({ from: from[2], line, kind: 'static' });
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(code)) !== null) {
      imports.push({ from: m[2], line, kind: 'require' });
      if (m.index === REQUIRE_RE.lastIndex) REQUIRE_RE.lastIndex++;
    }
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    while ((m = DYNAMIC_IMPORT_RE.exec(code)) !== null) {
      imports.push({ from: m[2], line, kind: 'dynamic' });
      if (m.index === DYNAMIC_IMPORT_RE.lastIndex) DYNAMIC_IMPORT_RE.lastIndex++;
    }
    const defMatch = code.match(CALL_DEF_RE);
    if (defMatch && !KEYWORDS.has(defMatch[1])) return;
    CALL_RE.lastIndex = 0;
    let c;
    while ((c = CALL_RE.exec(code)) !== null) {
      if (!KEYWORDS.has(c[1]) && c[1] !== definedHere) calls.push({ name: c[1], line });
      if (c.index === CALL_RE.lastIndex) CALL_RE.lastIndex++;
    }
  });
  for (const s of symbols) {
    if (exported.has(s.name)) s.exported = true;
  }
  return { path, symbols, imports, calls };
}

// Resolve a relative import specifier against the importing file. `hasFile`
// is injected (fs.existsSync in prod, a Set in tests). Non-relative
// specifiers (bare packages, node: builtins, URLs, aliases) return null
// and are recorded as external by buildGraph — never guessed.
export function resolveImport(fromPath, spec, hasFile) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
  const has = typeof hasFile === 'function' ? hasFile : () => false;
  // Python package semantics: level = leading-dot count (level 1 stays in
  // the current package); candidates are mod.py and mod/__init__.py.
  // Bare and absolute imports never reach here (early null above).
  if (PY_PATH_RE.test(String(fromPath || ''))) {
    const dots = spec.match(/^(\.+)/)[1].length;
    const rest = spec.slice(dots).split('.').filter((p) => p !== '');
    const segs = String(fromPath).split('/').slice(0, -1);
    for (let i = 1; i < dots; i++) segs.pop();
    for (const part of rest) segs.push(part);
    const base = segs.join('/');
    if (has(base)) return base;
    for (const suffix of PY_CANDIDATE_SUFFIXES) {
      if (has(base + suffix)) return base + suffix;
    }
    return null;
  }
  const segs = String(fromPath).split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  const base = segs.join('/');
  if (has(base)) return base;
  for (const ext of CANDIDATE_EXTS) {
    if (has(base + ext)) return base + ext;
  }
  for (const ext of CANDIDATE_EXTS) {
    if (has(base + '/index' + ext)) return base + '/index' + ext;
  }
  return null;
}

export function buildGraph(entries, { hasFile } = {}) {
  const files = {};
  const byPath = new Map((entries || []).map((e) => [e.path, e.text]));
  const has = typeof hasFile === 'function'
    ? hasFile
    : (p) => byPath.has(p);
  for (const { path, text } of entries || []) {
    if (!isCodePath(path)) continue;
    const mod = parseModule(path, text);
    const resolvedImports = mod.imports.map((imp) => {
      const target = resolveImport(path, imp.from, has);
      return target ? { ...imp, target } : { ...imp, target: null, external: true };
    });
    files[path] = { ...mod, imports: resolvedImports };
  }
  // edges: importer -> target (only resolved, internal targets).
  const edges = [];
  for (const [path, mod] of Object.entries(files)) {
    for (const imp of mod.imports) {
      if (imp.target && files[imp.target]) edges.push({ from: path, to: imp.target, line: imp.line });
    }
  }
  return { files, edges };
}

export function enclosingSymbol(symbols, line) {
  let best = null;
  for (const s of symbols || []) {
    if (s.line <= line && (!best || s.line > best.line)) best = s;
  }
  return best;
}

// Blast radius of a finding: the file itself plus every transitive
// importer (who depends on this code), plus files that call into the
// named symbol. Cycles terminate (visited set). Symbol-level precision
// is best-effort: call attribution is by name, so common names
// over-approximate — the file list is the reliable signal.
export function blastRadius(graph, { file, symbol, line } = {}) {
  const files = graph && graph.files ? graph.files : {};
  if (!file || !files[file]) return { files: [], symbols: [] };
  let name = symbol || null;
  if (!name && typeof line === 'number') {
    const enc = enclosingSymbol(files[file].symbols, line);
    if (enc) name = enc.name;
  }
  // Reverse edges: target -> importers.
  const importers = {};
  for (const e of graph.edges || []) {
    if (!importers[e.to]) importers[e.to] = [];
    importers[e.to].push(e.from);
  }
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of importers[cur] || []) {
      if (!seen.has(next) && files[next]) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const out = [...seen];
  if (name) {
    for (const [path, mod] of Object.entries(files)) {
      if (path !== file && (mod.calls || []).some((c) => c.name === name)) {
        if (!seen.has(path)) {
          seen.add(path);
          out.push(path);
        }
      }
    }
  }
  const symbols = name ? [{ file, name }] : [];
  return { files: out.sort(), symbols };
}

export default { parseModule, resolveImport, buildGraph, blastRadius, enclosingSymbol, buildRepoGraph, resolveRepoFile };
