// PR commands: `@sentinel <command>` in a PR conversation comment.
// Pure parsing + permission gate. Transport lives in app.js.
import { RULE_PACK_VERSION, ruleIdsForPack, SEVERITY_MAP } from '../../lib/rulepack.js';

export const HANDLES = ['@sentinel', '@aftergraph-sentinel'];
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const COMMANDS = ['review', 'why', 'help'];
export const REPLY_MARKER = '<!-- sentinel-command -->';

// First line that starts with a handle wins. Returns null when the comment
// is not addressed to Sentinel; { cmd: 'unknown' } for an unrecognised verb.
export function parseCommand(body) {
  if (typeof body !== 'string') return null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const handle = HANDLES.find((h) => line.toLowerCase().startsWith(h + ' ') || line.toLowerCase() === h);
    if (!handle) continue;
    const rest = line.slice(handle.length).trim().split(/\s+/).filter(Boolean);
    const verb = (rest[0] || 'help').toLowerCase();
    if (!COMMANDS.includes(verb)) return { cmd: 'unknown', verb, args: rest.slice(1) };
    return { cmd: verb, args: rest.slice(1) };
  }
  return null;
}

// Only humans with write-level association may drive Sentinel. Bots (including
// Sentinel itself) are ignored so replies can never loop.
export function authorize(payload) {
  const user = payload?.comment?.user || payload?.sender || {};
  if (user.type === 'Bot' || /\[bot\]$/.test(user.login || '')) return { ok: false, reason: 'bot' };
  const assoc = payload?.comment?.author_association;
  if (!TRUSTED_ASSOCIATIONS.has(assoc)) return { ok: false, reason: `association:${assoc || 'none'}` };
  return { ok: true, login: user.login || null };
}

export function helpText() {
  return [
    REPLY_MARKER,
    '**Sentinel commands**',
    '',
    '- `@sentinel review`: re-review the exact current HEAD now and refresh the verdict card and `sentinel/review` check.',
    '- `@sentinel why <rule-id>`: explain a rule and its severity.',
    '- `@sentinel help`: this list.',
    '',
    `Sentinel reviews every push automatically. Verdicts bind to the exact HEAD; a newer push marks older verdicts STALE. Rule pack ${RULE_PACK_VERSION}.`,
  ].join('\n');
}

export function whyText(ruleId, pack = RULE_PACK_VERSION) {
  const ids = ruleIdsForPack(pack);
  if (!ruleId) return `${REPLY_MARKER}\nUsage: \`@sentinel why <rule-id>\`. Rules in pack ${pack}: ${ids.map((i) => `\`${i}\``).join(', ')}.`;
  if (!ids.includes(ruleId)) {
    return `${REPLY_MARKER}\n\`${ruleId}\` is not a rule in pack ${pack}. Known rules: ${ids.map((i) => `\`${i}\``).join(', ')}.`;
  }
  const sev = SEVERITY_MAP?.[ruleId] || 'unknown';
  return [
    REPLY_MARKER,
    `**\`${ruleId}\`** · severity \`${sev}\` · pack ${pack}`,
    '',
    'Deterministic rule: the same diff on the same HEAD always gives the same finding. Silence a reviewed false positive with `sentinel resolve --rule-id ' + ruleId + ' --file <path> --reason <text>`; the resolution is recorded, never hidden.',
  ].join('\n');
}

export function unknownText(verb) {
  return `${REPLY_MARKER}\nUnknown command \`${verb}\`. ${helpText().replace(REPLY_MARKER + '\n', '')}`;
}
