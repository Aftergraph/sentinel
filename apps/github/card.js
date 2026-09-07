// Verdict card: the only top-level comment Sentinel owns per PR,
// updated in place (never appended). Pure renderer + selector.

export const CARD_MARKER = '<!-- sentinel-verdict -->';

function short(sha) {
  return String(sha).slice(0, 7);
}

// Evidence is untrusted code text rendered into markdown: strip backtick
// runs (fence/code-span breakouts), collapse whitespace, cap length.
// lib/ findings are untouched — this is presentation-only.
function safeEvidence(text) {
  return String(text || '').replace(/`+/g, "'").replace(/\s+/g, ' ').slice(0, 300);
}

export function renderCard({ verdict, headSha, baseSha, rulePackVersion, summary, blocking, silenced = [], nonBlocking = [], delta = null, receiptId = null, staleReason = null }) {
  const pill = verdict === 'SHIP' ? '● SHIP' : verdict === 'STALE' ? '● STALE' : '● DO NOT SHIP';
  const lines = [];
  lines.push(CARD_MARKER);
  lines.push(`## Sentinel verdict — ${pill}`);
  lines.push('');
  lines.push(`HEAD \`${short(headSha)}\`` + (baseSha ? ` · base \`${short(baseSha)}\`` : '') + ` · pack \`${rulePackVersion}\``);
  if (summary) lines.push(`Diff: ${summary.files} file(s), +${summary.added}/-${summary.removed}`);
  lines.push('');
  if (verdict === 'STALE') {
    lines.push(`Previous verdict invalidated: ${staleReason || 'repository state changed after verification'}.`);
    lines.push('Re-running on the new HEAD.');
  } else if (blocking.length > 0) {
    lines.push(`### ${blocking.length} blocking finding(s)`);
    const shown = blocking.slice(0, 20);
    for (const f of shown) lines.push(`- \`${f.file}:${f.line}\` [${f.ruleId}] ${safeEvidence(f.evidence)}`);
    if (blocking.length > shown.length) lines.push(`- …and ${blocking.length - shown.length} more`);
  } else {
    lines.push('No blocking findings on the verified HEAD.');
  }
  if (delta && (delta.new.length > 0 || delta.fixed.length > 0)) {
    lines.push('');
    lines.push(`Since \`${short(delta.prevHeadSha)}\`: +${delta.new.length} new, -${delta.fixed.length} fixed`);
  }
  if (silenced.length > 0) lines.push(`Silenced (resolved): ${silenced.length}`);
  if ((nonBlocking || []).length > 0) lines.push(`Advisory (non-blocking): ${nonBlocking.length}`);
  lines.push('');
  if (receiptId) lines.push(`Receipt \`${receiptId}\``);
  lines.push('_Sentinel verdicts bind to the exact commit above; any new push invalidates this card._');
  return lines.join('\n');
}

export function findOwnComment(comments) {
  return (comments || []).find((c) => typeof c.body === 'string' && c.body.includes(CARD_MARKER)) || null;
}
