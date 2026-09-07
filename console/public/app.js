// Sentinel Console UI — vanilla JS over same-origin /api.
// UI projection is not canonical state: everything here is a LOCAL CLAIM
// unless an offline `sentinel verify` says otherwise.
const el = document.getElementById('view');
const toasts = document.getElementById('toasts');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s) => String(s ?? '').slice(0, 7);
const pill = (v) => v === 'SHIP' ? '<span class="pill ship">● SHIP</span>'
  : v === 'STALE' ? '<span class="pill stale">● STALE</span>'
  : v === 'DO_NOT_SHIP' ? '<span class="pill dns">● DO NOT SHIP</span>'
  : `<span class="pill gray">${esc(v || 'no verdict')}</span>`;

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  toasts.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 4000);
}

function skeleton(rows) {
  return Array.from({ length: rows }, () => '<div class="sk" style="height:44px" aria-hidden="true"></div>').join('');
}

function errBox(msg, retry) {
  return `<div class="errbox" role="alert"><p class="err">${esc(msg)}</p>` +
    (retry ? `<button data-retry>Retry</button>` : '') + `</div>`;
}

function findingsTable(title, rows) {
  if (!rows || rows.length === 0) return '';
  return `<h3>${esc(title)} (${rows.length})</h3><div class="tablewrap"><table class="findings">` +
    `<tr><th scope="col">Location</th><th scope="col">Rule</th><th scope="col">Evidence</th></tr>` +
    rows.map((f) => `<tr><td><code>${esc(f.file)}:${esc(String(f.line))}</code></td><td>${esc(f.ruleId)}</td><td>${esc(f.evidence)}</td></tr>`).join('') +
    '</table></div>';
}

function reviewHtml(r) {
  const f = r.findings || {};
  const d = r.delta;
  return `<p>${pill(r.verdict)} <span class="dim">pack <code>${esc(r.review?.rulePackVersion || '')}</code></span></p>` +
    (r.summary ? `<p class="dim">PR: ${r.summary.files} file(s), +${r.summary.added}/-${r.summary.removed}</p>` : '') +
    (r.staleReason ? `<p class="warn">STALE — ${esc(r.staleReason)}</p>` : '') +
    (d && (d.new.length || d.fixed.length)
      ? `<p>Since <code>${esc(short(d.prevHeadSha))}</code>: <span class="warn">+${d.new.length} new</span>, <span class="ok">-${d.fixed.length} fixed</span></p>` : '') +
    findingsTable('Blocking', f.blocking) +
    findingsTable('Silenced', f.silenced) +
    findingsTable('Advisory', f.nonBlocking) +
    findingsTable('Excluded', f.excluded) +
    (r.receipt ? `<h3>Receipt</h3><pre>${esc(r.receipt.receipt_id)}\nhead ${esc(short(r.review?.headSha))} · <button data-verify='${esc(JSON.stringify(r.receipt))}'>Verify</button> <span id="vout"></span></pre>` : '');
}

function setNav(path) {
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.getAttribute('href') === '#' + path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function focusContent() {
  const h = el.querySelector('h2');
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
}

async function vBoard() {
  el.innerHTML = skeleton(3);
  try {
    const { repos } = await api('GET', '/api/repos');
    if (repos.length === 0) {
      el.innerHTML = `<h2>Board</h2><div class="errbox"><p>No data yet — run your first review to populate this board.</p><p><a href="#/run">Go to Run →</a></p></div>`;
    } else {
      el.innerHTML = `<h2>Board</h2><div class="cards">` + repos.map((r) =>
        `<div class="card"><h3>${esc(r.repo)}</h3><p>${pill(r.lastVerdict)} <span class="dim">${esc(short(r.headSha))}</span></p>` +
        (r.receiptId ? `<p class="dim"><code>${esc(r.receiptId.slice(0, 12))}</code></p>` : '<p class="dim">no receipt</p>') +
        `</div>`).join('') + `</div>`;
    }
  } catch (e) {
    el.innerHTML = `<h2>Board</h2>` + errBox(`Could not reach the console server: ${e.message}`, true);
  }
  focusContent();
}

async function vRun() {
  el.innerHTML = `<h2>Run review</h2>
    <label for="repo">Repository (diff mode)</label><input id="repo" placeholder="owner/name" autocomplete="off">
    <label for="pr">PR number (optional in diff mode)</label><input id="pr" placeholder="0" inputmode="numeric">
    <label for="diff">Diff (paste unified diff; leave empty for PR mode)</label><textarea id="diff" spellcheck="false"></textarea>
    <div class="row"><button class="primary" id="go">Review</button></div><div id="out"></div>`;
  focusContent();
  document.getElementById('go').onclick = async (e) => {
    const btn = e.target;
    const out = document.getElementById('out');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    out.innerHTML = skeleton(4);
    try {
      const body = { repo: document.getElementById('repo').value || undefined };
      const pr = document.getElementById('pr').value;
      if (pr) body.pr = parseInt(pr, 10);
      const diff = document.getElementById('diff').value;
      if (diff.trim()) body.diff = diff;
      out.innerHTML = reviewHtml(await api('POST', '/api/review', body));
      toast('Review complete');
    } catch (err) { out.innerHTML = errBox(err.message, false); }
    btn.disabled = false;
    btn.textContent = 'Review';
  };
}

async function vRules() {
  el.innerHTML = skeleton(5);
  try {
    const { pack, rules } = await api('GET', '/api/rules');
    el.innerHTML = `<h2>Rules <span class="dim">pack <code>${esc(pack)}</code> (read-only — packs change in code, not here)</span></h2>` +
      `<div class="tablewrap"><table class="findings"><tr><th scope="col">Rule</th><th scope="col">Severity</th><th scope="col">Blocks</th></tr>` +
      rules.map((r) => `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.severity)}</td><td>${r.blocks ? '<span class="bad">yes</span>' : '<span class="dim">advisory</span>'}</td></tr>`).join('') + `</table></div>`;
  } catch (e) { el.innerHTML = `<h2>Rules</h2>` + errBox(e.message, true); }
  focusContent();
}

async function vConfig() {
  el.innerHTML = skeleton(3);
  try {
    const { config, configHash } = await api('GET', '/api/config');
    el.innerHTML = `<h2>Config</h2><p class="dim">hash <code>${esc(configHash || 'none')}</code></p>
      <label for="pack">rulePack</label><input id="pack" value="${esc(config.rulePack || '')}" placeholder="1.1.0" autocomplete="off">
      <label for="ex">exclude (one glob per line)</label><textarea id="ex" spellcheck="false">${esc((config.exclude || []).join('\n'))}</textarea>
      <div class="row"><button class="primary" id="save">Save</button></div><div id="out"></div>`;
    focusContent();
    document.getElementById('save').onclick = async (e) => {
      const btn = e.target;
      const out = document.getElementById('out');
      btn.disabled = true;
      try {
        const pack = document.getElementById('pack').value.trim();
        const exclude = document.getElementById('ex').value.split('\n').map((s) => s.trim()).filter(Boolean);
        const saved = await api('PUT', '/api/config', { rulePack: pack || null, exclude });
        out.innerHTML = `<p class="ok">Saved — hash <code>${esc(saved.configHash)}</code></p>`;
        toast('Config saved');
      } catch (err) { out.innerHTML = errBox(err.message, false); }
      btn.disabled = false;
    };
  } catch (e) { el.innerHTML = `<h2>Config</h2>` + errBox(e.message, true); }
}

async function vLedger(q) {
  const repo = q.get('repo') || '';
  const pr = q.get('pr') || '';
  el.innerHTML = `<h2>Ledger</h2>
    <div class="row"><div><label for="lr">Repository</label><input id="lr" placeholder="owner/name" value="${esc(repo)}" autocomplete="off"></div><div><label for="lp">PR</label><input id="lp" placeholder="pr" value="${esc(pr)}" inputmode="numeric"></div><button id="go">Load</button></div><div id="out"></div>`;
  focusContent();
  document.getElementById('go').onclick = () => {
    location.hash = `#/ledger?repo=${encodeURIComponent(document.getElementById('lr').value)}&pr=${encodeURIComponent(document.getElementById('lp').value)}`;
  };
  if (!repo || !pr) return;
  const out = document.getElementById('out');
  out.innerHTML = skeleton(2);
  try {
    const { receipts } = await api('GET', `/api/ledger?repo=${encodeURIComponent(repo)}&pr=${encodeURIComponent(pr)}`);
    out.innerHTML = receipts.length === 0 ? '<div class="errbox"><p>No receipts for this repo+PR yet.</p><p><a href="#/run">Run a review →</a></p></div>' :
      receipts.map((r) => `<div class="card"><p>${pill(r.verdict)} <code>${esc(short(r.headSha))}</code> <span class="dim">${esc(r.timestamp)} · pack ${esc(r.rulePackVersion)}</span></p><pre>${esc(r.receipt_id)}\nprev ${esc(r.prev_receipt_id || 'none')}\nblocking ${r.counts?.blocking ?? '?'} · silenced ${r.counts?.silenced ?? '?'} · excluded ${r.counts?.excluded ?? '?'}</pre><button data-verify='${esc(JSON.stringify(r))}'>Verify</button> <span></span></div>`).join('');
  } catch (e) { out.innerHTML = errBox(e.message, false); }
}

el.addEventListener('click', async (e) => {
  const retry = e.target.closest('button[data-retry]');
  if (retry) { route(); return; }
  const btn = e.target.closest('button[data-verify]');
  if (!btn) return;
  const slot = btn.nextElementSibling;
  slot.textContent = 'checking…';
  try {
    const r = await api('POST', '/api/verify', { receipt: JSON.parse(btn.dataset.verify) });
    slot.innerHTML = r.valid ? '<span class="ok">VALID</span>' : `<span class="bad">INVALID — ${esc(r.reason || '')}</span>`;
  } catch (err) { slot.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
});

async function route() {
  const m = (location.hash || '#/board').match(/^#(\/[^?]*)(\?.*)?$/);
  const path = m ? m[1] : '/board';
  const q = new URLSearchParams(m && m[2] ? m[2] : '');
  setNav(path);
  if (path === '/run') return vRun();
  if (path === '/rules') return vRules();
  if (path === '/config') return vConfig();
  if (path === '/ledger') return vLedger(q);
  return vBoard();
}
window.addEventListener('hashchange', route);
route();
