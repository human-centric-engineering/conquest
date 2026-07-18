/**
 * Word-level text diff (LCS) for side-by-side comparison — no dependencies.
 *
 * Tokenises on whitespace (keeping the whitespace tokens so text reconstructs exactly), computes the
 * longest common subsequence, and returns a flat list of segments each tagged `eq` (unchanged), `del`
 * (only in the left/old text) or `ins` (only in the right/new text). Callers render the left column from
 * `eq`+`del` and the right column from `eq`+`ins`, highlighting the changes.
 *
 * The LCS table is O(n·m); to stay cheap in the browser, inputs beyond {@link MAX_TOKENS} tokens fall
 * back to a whole-block replace (the whole left is `del`, the whole right is `ins`).
 */

export type DiffType = 'eq' | 'del' | 'ins';

export interface DiffSegment {
  text: string;
  type: DiffType;
}

/**
 * Above this token count on either side, skip the O(n·m) table and emit a whole-block replace.
 *
 * The LCS table is a `number[][]` of (n+1)·(m+1) entries allocated in the browser, so the cap bounds
 * worst-case memory: 1500² ≈ 2.25M entries (~18 MB), versus ~128 MB at 4000. Reports run to a few
 * hundred–low thousand words, so this still diffs real content precisely and only degrades on outliers.
 */
export const MAX_TOKENS = 1500;

function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

export function diffWords(a: string, b: string): DiffSegment[] {
  const A = tokenize(a);
  const B = tokenize(b);
  const out: DiffSegment[] = [];
  const push = (text: string, type: DiffType) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ text, type });
  };

  if (A.length > MAX_TOKENS || B.length > MAX_TOKENS) {
    if (a) push(a, 'del');
    if (b) push(b, 'ins');
    return out;
  }

  const n = A.length;
  const m = B.length;
  // dp[i][j] = length of the LCS of A[i:] and B[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push(A[i], 'eq');
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(A[i], 'del');
      i++;
    } else {
      push(B[j], 'ins');
      j++;
    }
  }
  while (i < n) push(A[i++], 'del');
  while (j < m) push(B[j++], 'ins');
  return out;
}
