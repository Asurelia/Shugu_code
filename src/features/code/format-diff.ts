/**
 * format-diff.ts
 *
 * Computes a minimal set of CodeMirror ChangeSpec[] between an original doc
 * and a formatted string, using per-line LCS (Longest Common Subsequence).
 *
 * Why per-line LCS instead of full-replace?
 * - CodeMirror 6 maps selections through ChangeSpecs natively, preserving
 *   cursor position when surrounding lines are untouched.
 * - Full-replace (from: 0, to: doc.length) resets the cursor to position 0,
 *   which is jarring on format-on-save.
 * - LCS is O(N²) in line count — acceptable for real source files, but we
 *   fall back to full-replace for files > 500,000 chars to bound cost.
 *
 * Key design: byte cursors (aPos, bPos) advance through the strings in
 * lockstep with the LCS edit script. For each mismatch run, the change is
 * formed from exact byte slices — no string reconstruction needed.
 */

import type { Text, ChangeSpec } from "@codemirror/state";

const SIZE_THRESHOLD = 500_000;

/**
 * Computes a minimal list of ChangeSpec to transform `doc` into `formatted`.
 * Returns [] if doc and formatted are identical (no dispatch needed).
 */
export function computeMinimalChanges(
  doc: Text,
  formatted: string,
): ChangeSpec[] {
  const original = doc.toString();

  // Fast-path: no change
  if (original === formatted) return [];

  // Size guard: skip LCS for very large files
  if (Math.max(original.length, formatted.length) > SIZE_THRESHOLD) {
    return [{ from: 0, to: doc.length, insert: formatted }];
  }

  // Split by \n — \r (from CRLF) stays inside line content.
  // For LCS *matching*, strip trailing \r so "line\r" == "line".
  const aRaw = original.split("\n");
  const bRaw = formatted.split("\n");
  const aLines = aRaw.map((l) => l.replace(/\r$/, ""));
  const bLines = bRaw.map((l) => l.replace(/\r$/, ""));

  const m = aLines.length;
  const n = bLines.length;

  // Build LCS dp table.
  // dp[i*(n+1)+j] = LCS length for aLines[i..m] vs bLines[j..n].
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const idx = i * (n + 1) + j;
      if (aLines[i] === bLines[j]) {
        dp[idx] = 1 + dp[(i + 1) * (n + 1) + (j + 1)];
      } else {
        const down = dp[(i + 1) * (n + 1) + j];
        const right = dp[i * (n + 1) + (j + 1)];
        dp[idx] = down > right ? down : right;
      }
    }
  }

  // Walk the edit script using byte cursors.
  // aPos/bPos point to the start of the current line's *content* (not separator).
  // After matching or skipping a line, they advance by:
  //   content bytes (aRaw[k].length) + separator byte (1 if not last line, else 0)
  //
  // For a matched pair (i, j):
  //   - content bytes always match (same normalized content)
  //   - separator bytes may differ (trailing-newline asymmetry)
  //   If aSep != bSep, we emit a ChangeSpec for the separator difference.

  const changes: ChangeSpec[] = [];
  let i = 0;
  let j = 0;
  let aPos = 0;
  let bPos = 0;

  // Bytes occupied by line k in the original/formatted string, including its separator.
  const aBytes = (k: number) => aRaw[k].length + (k < m - 1 ? 1 : 0);
  const bBytes = (k: number) => bRaw[k].length + (k < n - 1 ? 1 : 0);

  while (i < m || j < n) {
    if (i < m && j < n && aLines[i] === bLines[j]) {
      // Normalized line content matches.
      const aContent = aRaw[i].length; // raw content bytes (may include \r)
      const bContent = bRaw[j].length;
      const aSep = i < m - 1 ? 1 : 0; // 1 if there's a \n after this line in a
      const bSep = j < n - 1 ? 1 : 0; // 1 if there's a \n after this line in b

      if (aContent !== bContent) {
        // Raw content differs (e.g., CRLF line has \r, LF line doesn't).
        // Emit a ChangeSpec to rewrite this line's content + separator together.
        const from = aPos;
        const to = aPos + aContent + aSep;
        const insert = bRaw[j] + (bSep === 1 ? "\n" : "");
        changes.push({ from, to, insert });
        aPos += aContent + aSep;
        bPos += bContent + bSep;
      } else {
        // Content bytes match — advance past content
        aPos += aContent;
        bPos += bContent;

        if (aSep === bSep) {
          // Separators also match — advance past them together
          aPos += aSep;
          bPos += bSep;
        } else {
          // Separator mismatch: emit a ChangeSpec for the separator delta
          const fromSep = aPos;
          const toSep = aPos + aSep;
          const insertSep = bSep === 1 ? "\n" : "";
          aPos += aSep;
          bPos += bSep;
          changes.push({ from: fromSep, to: toSep, insert: insertSep });
        }
      }

      i++;
      j++;
    } else {
      // Mismatch run — collect consecutive differing lines
      const fromPos = aPos;
      const bInsertStart = bPos;

      while (i < m || j < n) {
        if (i < m && j < n && aLines[i] === bLines[j]) break;
        const dpDown =
          i + 1 <= m && j <= n ? dp[(i + 1) * (n + 1) + j] : 0;
        const dpRight =
          i <= m && j + 1 <= n ? dp[i * (n + 1) + (j + 1)] : 0;
        if (i >= m) {
          bPos += bBytes(j);
          j++;
        } else if (j >= n) {
          aPos += aBytes(i);
          i++;
        } else if (dpDown >= dpRight) {
          aPos += aBytes(i);
          i++;
        } else {
          bPos += bBytes(j);
          j++;
        }
      }

      const from = fromPos;
      const to = aPos;
      const insert = formatted.slice(bInsertStart, bPos);
      changes.push({ from, to, insert });
    }
  }

  return changes;
}
