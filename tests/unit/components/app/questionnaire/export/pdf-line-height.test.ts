/**
 * Guard: no `lineHeight` without a `fontSize` in any React-PDF stylesheet.
 *
 * THE BUG THIS EXISTS TO PREVENT. `@react-pdf/renderer` resolves a unitless `lineHeight` into an
 * absolute point value using the `fontSize` declared *in the same style object* — falling back to
 * its own 18pt default when that object has none. It does NOT inherit the font size from the
 * `<Page>`, even though the glyphs themselves do. So this innocuous-looking style:
 *
 *   page:  { fontSize: 10, lineHeight: 1.4 }   // → 14pt leading, correct
 *   para:  { marginBottom: 6, lineHeight: 1.4 } // → 25.2pt leading (18 × 1.4), NOT 14pt
 *
 * renders 10pt text at 25.2pt leading — the respondent's report PDF came out double-spaced while
 * the on-screen version was fine, and every style around it (which happened to declare a fontSize)
 * looked correct, so the cause was invisible by inspection.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * A style in a PDF document declares `lineHeight` with no `fontSize` beside it. Either:
 *
 *   • drop the `lineHeight` — the `<Page>` style's already applies, and inherits correctly; or
 *   • add the explicit `fontSize` that style renders at, so the multiplier resolves against it.
 *
 * Do not silence this by deleting the file from the scan.
 *
 * @see components/app/questionnaire/export/session-pdf-document.tsx
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import resolveStyles from '@react-pdf/stylesheet';

/** A4 at 72dpi with react-pdf's own defaults — the container the renderer resolves styles against. */
const CONTAINER = { width: 595.28, height: 841.89, dpi: 72, remBase: 18 };

/** Directories that hold React-PDF documents. */
const ROOTS = ['components', 'app', 'lib'];

/** Every source file that builds a React-PDF stylesheet. */
function pdfStyleSheetFiles(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    const dir = path.join(process.cwd(), root);
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      const source = readFileSync(file, 'utf8');
      if (source.includes('@react-pdf/renderer') && source.includes('StyleSheet.create(')) {
        found.push(path.relative(process.cwd(), file));
      }
    }
  }
  return found.sort();
}

/** Strip comments so braces inside prose can't confuse the brace walker below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * The named style objects inside a file's `StyleSheet.create({...})` calls, as `[name, body]`.
 * Brace-walked rather than regexed so a style containing a nested object is still read whole.
 */
function styleEntries(source: string): Array<[string, string]> {
  const clean = stripComments(source);
  const entries: Array<[string, string]> = [];
  const marker = 'StyleSheet.create(';

  for (let at = clean.indexOf(marker); at !== -1; at = clean.indexOf(marker, at + 1)) {
    const open = clean.indexOf('{', at);
    if (open === -1) continue;
    let depth = 0;
    let entryStart = -1;
    for (let i = open; i < clean.length; i += 1) {
      const char = clean[i];
      if (char === '{') {
        depth += 1;
        if (depth === 2) entryStart = i + 1;
      } else if (char === '}') {
        if (depth === 2 && entryStart !== -1) {
          const name = /([\w'"]+)\s*:\s*\{$/.exec(clean.slice(0, entryStart))?.[1] ?? '(anonymous)';
          entries.push([name.replace(/['"]/g, ''), clean.slice(entryStart, i)]);
          entryStart = -1;
        }
        depth -= 1;
        if (depth === 0) break;
      }
    }
  }
  return entries;
}

describe('React-PDF lineHeight resolution', () => {
  it('resolves a unitless lineHeight against the SAME style object, defaulting to 18pt', () => {
    // The upstream behaviour the rule below exists for. If this ever changes — react-pdf starts
    // inheriting the page font size — the rule can be relaxed, but not before.
    expect(resolveStyles(CONTAINER, { fontSize: 10, lineHeight: 1.4 }).lineHeight).toBe(14);
    expect(resolveStyles(CONTAINER, { fontSize: 8, lineHeight: 1.4 }).lineHeight).toBeCloseTo(11.2);
    // No fontSize beside it → 18 × 1.4, nearly double what 10pt body text should get.
    expect(resolveStyles(CONTAINER, { marginBottom: 6, lineHeight: 1.4 }).lineHeight).toBeCloseTo(
      25.2
    );
  });

  it('finds the PDF documents to check', () => {
    // A scan that silently matches nothing would pass forever. Pin that it sees the report PDF.
    const files = pdfStyleSheetFiles();
    expect(files).toContain('components/app/questionnaire/export/session-pdf-document.tsx');
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('declares no lineHeight without a fontSize beside it', () => {
    const offenders: string[] = [];
    for (const file of pdfStyleSheetFiles()) {
      for (const [name, body] of styleEntries(readFileSync(file, 'utf8'))) {
        if (/\blineHeight\s*:/.test(body) && !/\bfontSize\s*:/.test(body)) {
          offenders.push(`${file} → styles.${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
