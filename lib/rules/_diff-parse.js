// Shared unified-diff parser for Sentinel rules.
// Pure, deterministic, zero deps.

export function parseDiff(text) {
  const lines = text.split('\n');
  const files = [];
  let current = null;
  let lineNo = 0;
  let pendingOld = null; // `--- ` path awaiting its `+++ ` line (deleted-file case below)

  for (const rawLine of lines) {
    // Case: CRLF diffs — strip one trailing CR so it cannot leak into paths/text
    // (a `a.js\r` path fails JS_PATH_RE and would silently skip the file's rules).
    const raw = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (raw.startsWith('diff --git')) { pendingOld = null; continue; }
    if (raw.startsWith('--- ')) { pendingOld = raw.slice(4); continue; }
    if (raw.startsWith('+++ b/')) {
      current = { path: raw.slice(6), hunks: [], addedLines: [], removedCount: 0 };
      files.push(current);
      lineNo = 0;
      pendingOld = null;
      continue;
    }
    // Case: deleted file (`--- a/old` + `+++ /dev/null`) — its removals were
    // silently dropped (no entry created). `--- /dev/null` + `+++ /dev/null`
    // still yields no file, matching the empty-diff contract.
    if (raw === '+++ /dev/null') {
      if (pendingOld && pendingOld !== '/dev/null') {
        const p = pendingOld.startsWith('a/') ? pendingOld.slice(2) : pendingOld;
        current = { path: p, hunks: [], addedLines: [], removedCount: 0 };
        files.push(current);
        lineNo = 0;
      }
      pendingOld = null;
      continue;
    }
    if (!current) continue;

    const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      lineNo = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.addedLines.push({ line: lineNo, text: raw.slice(1) });
      lineNo++;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      current.removedCount++;
      // removed line — don't advance new-file line counter
    } else if (raw.startsWith(' ') || raw === '') {
      lineNo++;
    }
  }

  return files;
}
