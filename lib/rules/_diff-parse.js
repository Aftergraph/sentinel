// Shared unified-diff parser for Sentinel rules.
// Pure, deterministic, zero deps.

export function parseDiff(text) {
  const lines = text.split('\n');
  const files = [];
  let current = null;
  let lineNo = 0;

  for (const raw of lines) {
    if (raw.startsWith('+++ b/')) {
      current = { path: raw.slice(6), hunks: [], addedLines: [], removedCount: 0 };
      files.push(current);
      lineNo = 0;
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
