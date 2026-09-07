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
  return Array.from({ length: rows }, () => '<div class="sk" aria-hidden="true"></div>').join('');
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

async function vOverview() {
  el.innerHTML = skeleton(4);
  try {
    const o = await api('GET', '/api/overview');
    const cards = [
      ['Open', o.open, 'tracked repositories'],
      ['Blocked', o.blocked, 'latest verdict DO NOT SHIP'],
      ['Stale', o.stale, 'latest verdict STALE'],
      ['Critical', o.critical, 'outstanding blocking findings'],
    ].map(([label, n, hint]) =>
      `<article class="card" tabindex="0" aria-label="${esc(label)}: ${esc(String(n))}"><h3>${esc(label)}</h3><p class="bignum">${esc(String(n))}</p><p class="dim">${esc(hint)}</p></article>`).join('');
    const queue = o.needsAttention.length === 0
      ? '<p class="ok">◆ All clear — nothing needs attention.</p>'
      : '<ol class="queue">' + o.needsAttention.map((q) =>
        `<li>${pill(q.verdict)} <strong>${esc(q.repo)}</strong> <span class="dim">${esc(q.reason)}` +
        (q.headSha ? ` · <code>${esc(short(q.headSha))}</code>` : '') + '</span></li>').join('') + '</ol>';
    const recent = o.recentVerdicts.length === 0
      ? '<p class="dim">No verdicts recorded yet.</p>'
      : '<ul class="queue">' + o.recentVerdicts.map((r) =>
        `<li>${pill(r.verdict)} <strong>${esc(r.repo)}#${esc(String(r.prNumber ?? ''))}</strong> ` +
        `<span class="dim"><code>${esc(short(r.headSha))}</code> · ${esc(r.timestamp || '')}</span></li>`).join('') + '</ul>';
    el.innerHTML = '<h2>Overview</h2>' +
      `<p class="ov-confidence" role="status">◆ AI confidence ${esc(String(o.confidence))} <span class="dim">(share of verdicts SHIP; model estimate, not evidence)</span></p>` +
      `<section aria-label="Status cards"><div class="cards ov-cards">${cards}</div></section>` +
      `<section aria-label="Needs attention"><h3>Needs attention (${o.needsAttention.length})</h3>${queue}</section>` +
      `<section aria-label="Recent verdicts"><h3>Recent verdicts</h3>${recent}</section>`;
  } catch (e) { el.innerHTML = '<h2>Overview</h2>' + errBox(e.message, true); }
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

const PR_TABS = ['Overview', 'Findings', 'Evidence', 'Activity'];

const SEV_ICON = { security: '⬢', reliability: '⬣', correctness: '◆', data: '⬔', performance: '▲', style: '○', unknown: '?' };

function findingItem(f) {
  const blocking = f.blocking
    ? '<span class="pill dns">● blocked</span>'
    : '<span class="pill gray">○ advisory</span>';
  const verified = f.verificationState === 'CONFIRMED'
    ? '<span class="pill verified">● CONFIRMED</span>'
    : `<span class="pill gray">? ${esc(f.verificationState || 'unknown')}</span>`;
  const conf = typeof f.aiConfidence === 'number'
    ? `◆ AI confidence ${esc(String(f.aiConfidence))} <span class="dim">(model estimate, not evidence)</span>`
    : '◆ AI confidence n/a <span class="dim">(model estimate, not evidence)</span>';
  return `<li class="finding"><span class="sev" aria-label="severity ${esc(f.severity || 'unknown')}">${esc(SEV_ICON[f.severity] || '?')} ${esc(f.severity || 'unknown')}</span> ` +
    `<strong>${esc(f.ruleId)}</strong> <code>${esc(f.file)}:${esc(String(f.line ?? ''))}</code> ${blocking}` +
    (f.evidence ? `<p>${esc(f.evidence)}</p>` : '') +
    `<p class="pr-ai">${conf}</p><p>Verification: ${verified}</p></li>`;
}

function prPanels(p) {
  const staleBanner = (p.stale || p.verdict === 'STALE')
    ? `<p class="stale-banner" role="status">◐ STALE — ${esc(p.staleReason || `verdict STALE at ${short(p.headSha)}`)}</p>` : '';
  // Verdict-override banner: attention, not failure/success — amber via
  // .override-banner (never red/green), icon+label+text, every value
  // through esc(). Renders only when the record carries an override.
  const o = (p.overridden && typeof p.overridden === 'object') ? p.overridden : null;
  const overrideBanner = (o || p.overriddenFrom != null)
    ? `<p class="override-banner" role="status">○ OVERRIDDEN — by ${esc(o?.actor ?? '')} (${esc(o?.reason ?? '')}) — was ${esc(o?.from ?? p.overriddenFrom ?? '')}</p>` : '';
  // Policy evaluation line: `policy <name>@<hash> <verdict>`, present only
  // when the record carries an evaluation (absent cleanly when null).
  const pe = (p.policyEvaluation && typeof p.policyEvaluation === 'object') ? p.policyEvaluation : null;
  const policyLine = pe
    ? `<p class="dim">policy ${esc(pe.policyVersion ?? 'unknown')} ${esc(pe.verdict ?? '')}</p>` : '';
  const overview = `${staleBanner}${overrideBanner}<p>${pill(p.verdict)} <span class="dim">pack <code>${esc(p.rulePackVersion || '')}</code></span></p>${policyLine}` +
    `<p>HEAD <code>${esc(p.headSha)}</code>` +
    (p.requestedHead ? ` · requested <code>${esc(p.requestedHead)}</code>` : '') + `</p>` +
    (p.counts ? `<p class="dim">blocking ${p.counts.blocking ?? '?'} · silenced ${p.counts.silenced ?? '?'} · advisory ${p.counts.nonBlocking ?? '?'} · excluded ${p.counts.excluded ?? '?'}</p>` : '') +
    (p.receipt ? `<h3>Receipt</h3><pre>${esc(p.receiptId)}\nhead ${esc(short(p.headSha))} · <button data-verify='${esc(JSON.stringify(p.receipt))}'>Verify</button> <span></span></pre>` : '');
  const groups = [['Blocking', p.blocking], ['Advisory', p.nonBlocking], ['Silenced', p.silenced]]
    .filter(([, rows]) => rows && rows.length > 0)
    .map(([t, rows]) => `<h3>${esc(t)} (${rows.length})</h3><ul class="findings-list">` + rows.map(findingItem).join('') + '</ul>').join('');
  const findings = groups || '<p class="dim">No findings recorded for this HEAD.</p>';
  const evidence = (p.evidence && p.evidence.length > 0)
    ? `<ul class="findings-list">` + p.evidence.map((e) =>
      `<li><code>${esc(e.id)}</code><p class="dim">sha256 <code>${esc(e.hash)}</code> · ${esc(e.ruleId || '')} ${esc(e.file || '')}${e.line != null ? ':' + esc(String(e.line)) : ''}</p></li>`).join('') + '</ul>'
    : '<p class="dim">No sealed evidence attached yet.</p>';
  const activity = (p.activity && p.activity.length > 0)
    ? `<ol class="queue">` + p.activity.map((a) =>
      `<li>${pill(a.verdict)} <code>${esc(short(a.headSha))}</code> <span class="dim">#${a.seq} · ${esc(a.timestamp || '')}</span><br><code>${esc((a.receiptId || '').slice(0, 12))}</code></li>`).join('') + '</ol>'
    : '<p class="dim">No receipt trail for this PR yet.</p>';
  return { Overview: overview, Findings: findings, Evidence: evidence, Activity: activity };
}

function renderPrTabs(host, p) {
  const panels = prPanels(p);
  const tabs = PR_TABS.map((t, i) =>
    `<button role="tab" id="pr-tab-${t}" aria-controls="pr-panel-${t}" aria-selected="${i === 0 ? 'true' : 'false'}" tabindex="${i === 0 ? '0' : '-1'}">${t}</button>`).join('');
  const bodies = PR_TABS.map((t, i) =>
    `<div role="tabpanel" id="pr-panel-${t}" aria-labelledby="pr-tab-${t}" tabindex="0"${i === 0 ? '' : ' hidden'}>${panels[t]}</div>`).join('');
  host.innerHTML = `<section aria-label="PR detail ${esc(p.repo)} number ${esc(String(p.prNumber))}">` +
    `<p>${pill(p.verdict)} <strong>${esc(p.repo)}#${esc(String(p.prNumber))}</strong> <span class="dim"><code>${esc(short(p.headSha))}</code></span></p>` +
    `<div class="tabs" role="tablist" aria-label="PR detail sections">${tabs}</div>${bodies}</section>`;
  const tablist = host.querySelector('[role="tablist"]');
  const tabEls = Array.from(tablist.querySelectorAll('[role="tab"]'));
  const select = (idx) => {
    tabEls.forEach((tab, i) => {
      const on = i === idx;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      const panel = host.querySelector('#' + tab.getAttribute('aria-controls'));
      if (on) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
    tabEls[idx].focus();
  };
  tablist.addEventListener('keydown', (e) => {
    const cur = tabEls.indexOf(document.activeElement);
    if (cur === -1) return;
    let next = null;
    if (e.key === 'ArrowRight') next = (cur + 1) % tabEls.length;
    else if (e.key === 'ArrowLeft') next = (cur - 1 + tabEls.length) % tabEls.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabEls.length - 1;
    if (next !== null) { e.preventDefault(); select(next); }
  });
  tabEls.forEach((tab, i) => tab.addEventListener('click', () => select(i)));
}

async function vPR(q) {
  const repo = q.get('repo') || '';
  const pr = q.get('pr') || '';
  const head = q.get('head') || '';
  el.innerHTML = `<h2>PR detail</h2>
    <div class="row"><div><label for="prr">Repository</label><input id="prr" placeholder="owner/name" value="${esc(repo)}" autocomplete="off"></div><div><label for="prp">PR</label><input id="prp" placeholder="pr" value="${esc(pr)}" inputmode="numeric"></div><div><label for="prh">Requested HEAD (optional, for STALE check)</label><input id="prh" placeholder="head sha" value="${esc(head)}" autocomplete="off"></div><button id="go">Load</button></div><div id="out"></div>`;
  focusContent();
  document.getElementById('go').onclick = () => {
    const parts = [`repo=${encodeURIComponent(document.getElementById('prr').value)}`, `pr=${encodeURIComponent(document.getElementById('prp').value)}`];
    const h = document.getElementById('prh').value.trim();
    if (h) parts.push(`head=${encodeURIComponent(h)}`);
    location.hash = `#/pr?${parts.join('&')}`;
  };
  if (!repo || !pr) return;
  const out = document.getElementById('out');
  out.innerHTML = skeleton(4);
  try {
    const p = await api('GET', `/api/pr/${encodeURIComponent(repo)}/${encodeURIComponent(pr)}${head ? `?head=${encodeURIComponent(head)}` : ''}`);
    renderPrTabs(out, p);
    toast('PR loaded');
  } catch (e) { out.innerHTML = errBox(e.message, false); }
}

// Deterministic suggestion text per rule family. Always framed as a
// suggestion, never an instruction — the reviewer decides.
function suggestedFixFor(ruleId) {
  const id = String(ruleId || '');
  if (id.startsWith('require-')) {
    return `Suggestion (not an instruction): satisfy ${id} by adding the required guard or construct near the flagged location, then re-run review to confirm.`;
  }
  if (id.startsWith('no-')) {
    return `Suggestion (not an instruction): remove or replace the flagged construct for ${id} near the flagged location, then re-run review to confirm.`;
  }
  return `Suggestion (not an instruction): review the flagged location against rule ${id || 'unknown'} and re-run review to confirm.`;
}

function findingDetailHtml(d, blast) {
  const f = d.finding;
  const conf = typeof f.aiConfidence === 'number'
    ? `◆ AI confidence ${esc(String(f.aiConfidence))} <span class="dim">(model estimate, not evidence)</span>`
    : '◆ AI confidence n/a <span class="dim">(model estimate, not evidence)</span>';
  const verified = f.verificationState === 'CONFIRMED'
    ? '<span class="pill verified">● CONFIRMED</span>'
    : `<span class="pill gray">? ${esc(f.verificationState || 'unknown')}</span>`;
  const blastHtml = !blast ? '<p class="dim">Blast-radius data unavailable.</p>'
    : blast.length === 0 ? '<p class="ok">◆ No other findings in this file.</p>'
    : `<ul class="findings-list">` + blast.map((g) =>
      `<li><a href="#/finding?repo=${encodeURIComponent(d.repo)}&pr=${encodeURIComponent(String(d.prNumber))}&rule=${encodeURIComponent(g.ruleId)}&line=${encodeURIComponent(String(g.line))}">${esc(g.ruleId)} <code>${esc(g.file)}:${esc(String(g.line))}</code></a> ` +
      `<span class="sev" aria-label="severity ${esc(g.severity || 'unknown')}">${esc(SEV_ICON[g.severity] || '?')} ${esc(g.severity || 'unknown')}</span></li>`).join('') + '</ul>';
  const evidenceHtml = (d.evidence && d.evidence.length > 0)
    ? `<ul class="findings-list">` + d.evidence.map((e) =>
      `<li><code>${esc(e.id)}</code><p class="dim">sha256 <code>${esc(e.hash)}</code></p></li>`).join('') + '</ul>'
    : '<p class="dim">No sealed evidence attached yet.</p>';
  const historyHtml = (d.history && d.history.length > 0)
    ? `<ol class="queue">` + d.history.map((h) =>
      `<li>${pill(h.verdict)} <code>${esc(short(h.headSha))}</code> <span class="dim">#${h.seq} · ${esc(h.timestamp || '')}</span><br><code>${esc((h.receiptId || '').slice(0, 12))}</code></li>`).join('') + '</ol>'
    : '<p class="dim">No earlier receipts touched this finding.</p>';
  return `<article aria-label="Finding detail ${esc(f.ruleId)} at ${esc(f.file)} line ${esc(String(f.line))}">` +
    `<p><span class="sev" aria-label="severity ${esc(f.severity || 'unknown')}">${esc(SEV_ICON[f.severity] || '?')} ${esc(f.severity || 'unknown')}</span> ` +
    `<strong>${esc(f.ruleId)}</strong> ${f.blocking ? '<span class="pill dns">● blocked</span>' : '<span class="pill gray">○ advisory</span>'}</p>` +
    `<section aria-label="Why this fired"><h3>Why this fired</h3>` +
    (f.evidence ? `<p>${esc(f.evidence)}</p>` : '<p class="dim">No evidence text recorded.</p>') +
    `<p>Code location: <code>${esc(f.file)}:${esc(String(f.line ?? ''))}</code></p></section>` +
    `<section class="finding-ai" aria-label="AI estimate"><h3>AI estimate</h3><p>${conf}</p></section>` +
    `<section class="finding-verified" aria-label="Verified evidence"><h3>Verified evidence</h3><p>Verification: ${verified}</p>${evidenceHtml}</section>` +
    `<section aria-label="Blast radius"><h3>Blast radius (${blast ? blast.length : '?'})</h3><p class="dim">Other findings in the same file.</p>${blastHtml}</section>` +
    `<section aria-label="Suggested fix"><h3>Suggested fix</h3><p>${esc(suggestedFixFor(f.ruleId))}</p></section>` +
    `<section aria-label="History"><h3>History (${(d.history || []).length})</h3>${historyHtml}</section>` +
    `</article>`;
}

async function vFinding(q) {
  const repo = q.get('repo') || '';
  const pr = q.get('pr') || '';
  const rule = q.get('rule') || '';
  const line = q.get('line') || '';
  el.innerHTML = `<h2>Finding detail</h2>
    <div class="row"><div><label for="fr">Repository</label><input id="fr" placeholder="owner/name" value="${esc(repo)}" autocomplete="off"></div><div><label for="fp">PR</label><input id="fp" placeholder="pr" value="${esc(pr)}" inputmode="numeric"></div><div><label for="frule">Rule</label><input id="frule" placeholder="rule id" value="${esc(rule)}" autocomplete="off"></div><div><label for="fline">Line</label><input id="fline" placeholder="line" value="${esc(line)}" inputmode="numeric"></div><button id="go">Load</button></div><div id="out"></div>`;
  focusContent();
  document.getElementById('go').onclick = () => {
    const parts = [`repo=${encodeURIComponent(document.getElementById('fr').value)}`, `pr=${encodeURIComponent(document.getElementById('fp').value)}`,
      `rule=${encodeURIComponent(document.getElementById('frule').value)}`, `line=${encodeURIComponent(document.getElementById('fline').value)}`];
    location.hash = `#/finding?${parts.join('&')}`;
  };
  if (!repo || !pr || !rule || !line) return;
  const out = document.getElementById('out');
  out.innerHTML = skeleton(4);
  try {
    const d = await api('GET', `/api/finding/${encodeURIComponent(repo)}/${encodeURIComponent(pr)}/${encodeURIComponent(rule)}/${encodeURIComponent(line)}`);
    let blast = null;
    try {
      const p = await api('GET', `/api/pr/${encodeURIComponent(repo)}/${encodeURIComponent(pr)}`);
      const all = [...(p.blocking || []), ...(p.nonBlocking || []), ...(p.silenced || [])];
      blast = all.filter((g) => g.file === d.finding.file && !(g.ruleId === d.finding.ruleId && Number(g.line) === Number(d.finding.line)));
    } catch { blast = null; }
    out.innerHTML = findingDetailHtml(d, blast);
    toast('Finding loaded');
  } catch (e) { out.innerHTML = errBox(e.message, false); }
}

// Health dashboard + ledger-integrity views: read-only polling over GET
// /api/health/verdicts and GET /api/ledger/verify (the token gate already
// on those routes covers these views — no new endpoints). Brand law —
// verdict totals render icon+label+text via the shared .pill/.ok/.bad hues
// (never color-only); STALE reuses .pill.stale. Both views have no motion
// of their own so the global prefers-reduced-motion block in styles.css
// covers them. All controls are native buttons/links, so both views are
// keyboard reachable. Every interpolated value goes through esc().
const HEALTH_TOTALS = [
  ['SHIP', '●', 'pill ship', 'receipts with verdict SHIP'],
  ['DO_NOT_SHIP', '●', 'pill dns', 'receipts with verdict DO NOT SHIP'],
  ['STALE', '●', 'pill stale', 'receipts with verdict STALE'],
  ['BLOCKED', '●', 'pill dns', 'receipts carrying a BLOCKED verdict'],
  ['OVERRIDDEN', '○', 'pill gray', 'receipts with a policy override'],
];

function healthCards(totals) {
  return HEALTH_TOTALS.map(([key, icon, cls, hint]) => {
    const n = totals && typeof totals[key] === 'number' ? totals[key] : 0;
    return `<article class="card" tabindex="0" aria-label="${esc(key)}: ${esc(String(n))}"><h3><span class="${esc(cls)}" aria-hidden="true">${esc(icon)} ${esc(key)}</span></h3><p class="bignum">${esc(String(n))}</p><p class="dim">${esc(hint)}</p></article>`;
  }).join('');
}

function topRulesHtml(byRule) {
  if (!byRule || byRule.length === 0) return '<p class="dim">No blocking rules recorded yet.</p>';
  return '<ol class="queue">' + byRule.slice(0, 10).map((e) =>
    `<li><strong>${esc(e.ruleId)}</strong> <span class="dim">× ${esc(String(typeof e.count === 'number' ? e.count : 0))} blocking finding(s)</span></li>`).join('') + '</ol>';
}

// Integrity panel: chain status only — ok:true renders the verified
// count; ok:false lists the bad receipt ids. Never a raw ledger dump.
function integrityHtml(v) {
  if (!v || v.ok !== false) {
    const n = v && typeof v.checked === 'number' ? v.checked : 0;
    return `<p class="ok" role="status">● Chain OK — ${esc(String(n))} receipt(s) verified.</p>`;
  }
  const bad = Array.isArray(v.bad) ? v.bad : [];
  return `<p class="bad" role="alert">● Chain FAILED — ${esc(String(bad.length))} bad receipt(s).</p>` +
    (bad.length === 0 ? '' : '<ul class="queue">' + bad.map((id) => `<li><code>${esc(id)}</code></li>`).join('') + '</ul>');
}

function healthHtml(h, v) {
  const receipts = h && h.window && typeof h.window.receipts === 'number' ? h.window.receipts : 0;
  if (receipts === 0) {
    return `<div class="errbox"><p>No verdicts recorded yet — run your first review to populate this dashboard.</p><p><a href="#/run">Go to Run →</a></p></div>` +
      `<section aria-label="Ledger integrity"><h3>Ledger integrity</h3>${integrityHtml(v)}</section>`;
  }
  return `<section aria-label="Verdict totals"><div class="cards">${healthCards(h.totals)}</div></section>` +
    `<section aria-label="Top blocking rules"><h3>Top blocking rules (${esc(String((h.byRule || []).length))})</h3>${topRulesHtml(h.byRule)}</section>` +
    `<section aria-label="Ledger integrity"><h3>Ledger integrity</h3>${integrityHtml(v)}</section>`;
}

let healthTimer = null;
function stopHealthPoll() {
  if (healthTimer !== null) { clearInterval(healthTimer); healthTimer = null; }
}

async function loadHealth(out) {
  try {
    const [h, v] = await Promise.all([
      api('GET', '/api/health/verdicts'),
      api('GET', '/api/ledger/verify'),
    ]);
    out.innerHTML = healthHtml(h, v);
  } catch (e) { out.innerHTML = errBox(e.message, false); }
}

async function vHealth() {
  el.innerHTML = `<h2>Health</h2><p class="dim">Verdict totals and top blocking rules (auto-refreshes every 5s).</p><div id="hout"></div>`;
  focusContent();
  const out = document.getElementById('hout');
  out.innerHTML = skeleton(4);
  await loadHealth(out);
  stopHealthPoll();
  healthTimer = setInterval(() => loadHealth(out), 5000);
}

let integrityTimer = null;
function stopIntegrityPoll() {
  if (integrityTimer !== null) { clearInterval(integrityTimer); integrityTimer = null; }
}

async function loadIntegrity(out) {
  try {
    out.innerHTML = integrityHtml(await api('GET', '/api/ledger/verify'));
  } catch (e) { out.innerHTML = errBox(e.message, false); }
}

async function vIntegrity() {
  el.innerHTML = `<h2>Integrity</h2><p class="dim">Ledger hash-chain status (auto-refreshes every 2s).</p><div class="row"><button id="irefresh">Refresh now</button></div><div id="iout"></div>`;
  focusContent();
  const out = document.getElementById('iout');
  out.innerHTML = skeleton(2);
  document.getElementById('irefresh').onclick = () => loadIntegrity(out);
  await loadIntegrity(out);
  stopIntegrityPoll();
  integrityTimer = setInterval(() => loadIntegrity(out), 2000);
}

// Verification-run view: plain polling over GET /api/verify/:runId (no
// websockets — a 2s setInterval refreshes the run; the timer is cleared on
// every route change). Brand law — statuses render icon+label+text via the
// shared .ok/.bad/.warn/.dim hues (never color-only); STALE reuses the
// .stale-banner banner; the view has no motion of its own so the global
// prefers-reduced-motion block in styles.css covers it. All controls are
// native inputs/buttons/links, so the view is keyboard reachable.
let verifyTimer = null;
function stopVerifyPoll() {
  if (verifyTimer !== null) { clearInterval(verifyTimer); verifyTimer = null; }
}

const VERIFY_STATUS = {
  PENDING: ['○', 'pending'],
  RUNNING: ['◌', 'running'],
  PASS: ['●', 'pass'],
  FAIL: ['●', 'fail'],
  REFUTED: ['●', 'refuted'],
};

function verifyCheckRow(c) {
  const known = VERIFY_STATUS[c.status];
  const icon = known ? known[0] : '?';
  const label = known ? known[1] : String(c.status || 'unknown').toLowerCase();
  return `<li class="verify-check" data-status="${esc(c.status)}"><span aria-hidden="true">${icon}</span> ` +
    `<strong>${esc(c.type)}</strong> <span>${esc(label)}</span> ` +
    `<span class="dim">${esc(c.type)} check ${esc(label)}</span></li>`;
}

function verifyHtml(run) {
  const total = run.progress ? run.progress.total : (run.checks || []).length;
  const done = run.progress ? run.progress.done : 0;
  const stale = run.stale
    ? `<p class="stale-banner" role="status">◐ STALE — run targets <code>${esc(short(run.targetSha))}</code> but ledger head is <code>${esc(short(run.ledgerHead))}</code></p>`
    : '';
  const fr = run.findingRef || {};
  const ev = (run.evidenceIds && run.evidenceIds.length > 0)
    ? `<ul class="verify-evidence">` + run.evidenceIds.map((id) =>
      `<li><a href="#/finding?repo=${encodeURIComponent(fr.repo || '')}&pr=${encodeURIComponent(String(fr.prNumber ?? ''))}&rule=${encodeURIComponent(fr.ruleId || '')}&line=${encodeURIComponent(String(fr.line ?? ''))}"><code>${esc(id)}</code></a> <span class="dim">sealed evidence</span></li>`).join('') + `</ul>`
    : '<p class="dim">No sealed evidence attached yet.</p>';
  return `<p><span class="pill info">● ${esc(run.status)}</span> <strong>${esc(run.id)}</strong> ` +
    `<span class="dim">finding <code>${esc(fr.ruleId || '')} ${esc(fr.file || '')}${fr.line != null ? ':' + esc(String(fr.line)) : ''}</code> · target <code>${esc(short(run.targetSha))}</code></span></p>` +
    stale +
    `<h3>Progress</h3><progress class="verify-progress" max="${total}" value="${done}" aria-label="Verification progress for ${esc(run.id)}">${esc(`${done}/${total}`)}</progress>` +
    `<p class="verify-count" role="status">${done}/${total} checks complete</p>` +
    `<h3>Checks (${(run.checks || []).length})</h3><ul class="verify-checks">` +
    (run.checks || []).map(verifyCheckRow).join('') + `</ul>` +
    `<h3>Sealed evidence (${(run.evidenceIds || []).length})</h3>${ev}`;
}

async function loadVerifyRun(id, out) {
  try {
    out.innerHTML = verifyHtml(await api('GET', `/api/verify/${encodeURIComponent(id)}`));
  } catch (e) { out.innerHTML = errBox(e.message, false); }
}

async function vVerify(q) {
  const repo = q.get('repo') || '';
  const pr = q.get('pr') || '';
  const rule = q.get('rule') || '';
  const line = q.get('line') || '';
  const run = q.get('run') || '';
  el.innerHTML = `<h2>Verification run</h2>
    <div class="row"><div><label for="vr">Repository</label><input id="vr" placeholder="owner/name" value="${esc(repo)}" autocomplete="off"></div><div><label for="vp">PR</label><input id="vp" placeholder="pr" value="${esc(pr)}" inputmode="numeric"></div><div><label for="vrule">Rule</label><input id="vrule" placeholder="rule id" value="${esc(rule)}" autocomplete="off"></div><div><label for="vline">Line</label><input id="vline" placeholder="line" value="${esc(line)}" inputmode="numeric"></div><button id="vstart" class="primary">Start run</button></div>
    <div class="row"><div><label for="vrun">Run id (poll an existing run)</label><input id="vrun" placeholder="VR-0001" value="${esc(run)}" autocomplete="off"></div><button id="vload">Load</button></div><div id="vout"></div>`;
  focusContent();
  const go = (id) => {
    const target = `#/verify?run=${encodeURIComponent(id)}`;
    if (location.hash === target) route();
    else location.hash = target;
  };
  document.getElementById('vstart').onclick = async (e) => {
    const btn = e.target;
    const out = document.getElementById('vout');
    btn.disabled = true;
    try {
      const started = await api('POST', '/api/verify/start', {
        repo: document.getElementById('vr').value,
        prNumber: Number(document.getElementById('vp').value),
        ruleId: document.getElementById('vrule').value,
        line: Number(document.getElementById('vline').value),
      });
      toast(`Run ${started.id} started`);
      go(started.id);
    } catch (err) { out.innerHTML = errBox(err.message, false); }
    btn.disabled = false;
  };
  document.getElementById('vload').onclick = () => go(document.getElementById('vrun').value.trim());
  if (!run) return;
  const out = document.getElementById('vout');
  out.innerHTML = skeleton(3);
  await loadVerifyRun(run, out);
  stopVerifyPoll();
  verifyTimer = setInterval(() => loadVerifyRun(run, out), 2000);
}

// Context view: read-only advisory blast-radius over GET
// /api/context/blast (S2 slice 2). Follows the existing view pattern:
// form -> hash params -> skeleton -> api() -> esc()'d HTML. Every
// interpolated value goes through esc(); statuses render icon+label+text.
function contextHtml(r) {
  const files = Array.isArray(r.files) ? r.files : [];
  const symbols = Array.isArray(r.symbols) ? r.symbols : [];
  const stats = r.stats && typeof r.stats === 'object' ? r.stats : null;
  const filesHtml = files.length === 0 ? '<p class="dim">No other files in scope.</p>'
    : '<ul class="queue">' + files.map((f) => `<li><code>${esc(f)}</code></li>`).join('') + '</ul>';
  const symbolsHtml = symbols.length === 0 ? '<p class="dim">No symbols in scope.</p>'
    : '<ul class="queue">' + symbols.map((s) =>
      `<li><code>${esc(s.file)}${s.name ? ' :: ' + esc(s.name) : ''}</code></li>`).join('') + '</ul>';
  return `<p><span class="pill info">● advisory</span> <code>${esc(r.file || '')}</code>` +
    (r.symbol ? ` <span class="dim">symbol <code>${esc(r.symbol)}</code></span>` : '') +
    (r.line != null ? ` <span class="dim">line <code>${esc(String(r.line))}</code></span>` : '') + `</p>` +
    (r.note ? `<p class="dim">${esc(r.note)}</p>` : '') +
    `<section aria-label="Affected files"><h3>Affected files (${files.length})</h3>${filesHtml}</section>` +
    `<section aria-label="Symbols"><h3>Symbols (${symbols.length})</h3>${symbolsHtml}</section>` +
    (stats ? `<p class="dim">scanned ${esc(String(stats.scanned ?? '?'))} file(s)` +
      (stats.truncated ? ` · walk truncated at ${esc(String(stats.maxFiles ?? '?'))}` : '') + `</p>` : '');
}

async function vContext(q) {
  const repoDir = q.get('repoDir') || '';
  const file = q.get('file') || '';
  const symbol = q.get('symbol') || '';
  const line = q.get('line') || '';
  el.innerHTML = `<h2>Context</h2>
    <p class="dim">Advisory blast-radius — what a file or symbol touches. Never affects verdicts or receipts.</p>
    <div class="row"><div><label for="cr">Repository directory</label><input id="cr" placeholder="/path/to/checkout" value="${esc(repoDir)}" autocomplete="off"></div><div><label for="cf">File (repo-relative)</label><input id="cf" placeholder="lib/review.js" value="${esc(file)}" autocomplete="off"></div><div><label for="cs">Symbol (optional)</label><input id="cs" placeholder="formatHuman" value="${esc(symbol)}" autocomplete="off"></div><div><label for="cl">Line (optional)</label><input id="cl" placeholder="333" value="${esc(line)}" inputmode="numeric"></div><button id="go">Load</button></div><div id="out"></div>`;
  focusContent();
  document.getElementById('go').onclick = () => {
    const parts = [`repoDir=${encodeURIComponent(document.getElementById('cr').value)}`, `file=${encodeURIComponent(document.getElementById('cf').value)}`];
    const s = document.getElementById('cs').value.trim();
    const l = document.getElementById('cl').value.trim();
    if (s) parts.push(`symbol=${encodeURIComponent(s)}`);
    if (l) parts.push(`line=${encodeURIComponent(l)}`);
    location.hash = `#/context?${parts.join('&')}`;
  };
  if (!repoDir || !file) return;
  const out = document.getElementById('out');
  out.innerHTML = skeleton(3);
  try {
    let target = `/api/context/blast?repoDir=${encodeURIComponent(repoDir)}&file=${encodeURIComponent(file)}`;
    if (symbol) target += `&symbol=${encodeURIComponent(symbol)}`;
    if (line) target += `&line=${encodeURIComponent(line)}`;
    out.innerHTML = contextHtml(await api('GET', target));
    toast('Context loaded');
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
  stopVerifyPoll();
  stopHealthPoll();
  stopIntegrityPoll();
  const m = (location.hash || '#/board').match(/^#(\/[^?]*)(\?.*)?$/);
  const path = m ? m[1] : '/board';
  const q = new URLSearchParams(m && m[2] ? m[2] : '');
  setNav(path);
  if (path === '/overview') return vOverview();
  if (path === '/health') return vHealth();
  if (path === '/integrity') return vIntegrity();
  if (path === '/run') return vRun();
  if (path === '/rules') return vRules();
  if (path === '/config') return vConfig();
  if (path === '/ledger') return vLedger(q);
  if (path === '/pr') return vPR(q);
  if (path === '/finding') return vFinding(q);
  if (path === '/verify') return vVerify(q);
  if (path === '/context') return vContext(q);
  return vBoard();
}
window.addEventListener('hashchange', route);
route();
// Service-worker registration lives here (not inline in index.html) so the
// console can serve a strict script-src 'self' Content-Security-Policy.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
