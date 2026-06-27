/**
 * Spreadsheet → faithful Markdown flattener (app-tier, ConQuest ingestion).
 *
 * This is the ONLY deterministic step in spreadsheet ingestion. Its single job
 * is to turn an `.xlsx` workbook into faithful plain text: every tab, every
 * used cell, every column — including the ID / foreign-key columns that wire
 * the tabs together. It makes **no** decision about what is a question, what is
 * a section, what is boilerplate, or how tabs relate. All of that intelligence
 * lives downstream in the extractor agent (see `extraction-prompt.ts`), so an
 * arbitrarily-structured workbook is handled by the model, not by hard-coded
 * schema assumptions here.
 *
 * Why app-tier (not the shared `lib/orchestration/knowledge/parsers` router):
 * the questionnaire flow wants tab-preserving, FK-preserving output tuned for an
 * LLM reader, and keeping it here avoids forking a Sunrise platform parser. It
 * returns the platform {@link ParsedDocument} shape so the ingest pipeline's
 * `.xlsx` branch is a drop-in alongside `parseDocument()`.
 *
 * Output shape: one `## Sheet: <name>` block per worksheet, each rendered as a
 * GitHub-flavoured Markdown table whose first used row is the header. Tables are
 * the most LLM-legible representation of column semantics (`SectionID`,
 * `Parent Section`, `Type`, …); key/value and prose sheets render as small or
 * single-column tables, which is harmless.
 */

import ExcelJS from 'exceljs';

import type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

/**
 * Hard cap on the flattened text fed to the extractor. The extractor sends the
 * whole document in a single reasoning call, so an unbounded workbook would blow
 * the context window and the cost budget. ~600k chars ≈ 150k tokens — generous
 * for a real questionnaire, while still bounding a pathological export. When the
 * budget is exhausted, remaining rows/sheets are dropped and a warning names
 * what was cut, so the truncation is never silent.
 */
export const MAX_FLATTENED_CHARS = 600_000;

/** Cap on a single rendered cell — a stray giant cell can't dominate the budget. */
const MAX_CELL_CHARS = 2_000;

/** Options for {@link flattenWorkbook}. Defaults match production ingestion. */
export interface FlattenWorkbookOptions {
  /** Override the flattened-text budget (tests use a small value). */
  maxChars?: number;
}

/**
 * Render one cell's value as a single line of plain text. ExcelJS `cell.text`
 * already resolves formulas, dates, hyperlinks, and rich text to a string; we
 * only normalise it for table-cell safety: collapse newlines, escape pipes, and
 * cap pathological lengths. We deliberately do NOT interpret meaning here.
 */
function cellToText(cell: ExcelJS.Cell): string {
  let text = cell.text ?? '';
  if (typeof text !== 'string') text = String(text);
  // Collapse intra-cell newlines/tabs so a cell stays on one table row; a single
  // space keeps adjacent words separated. `<br>` would inject markup the model
  // might echo, so plain space is safer.
  text = text.replace(/\r\n|\r|\n|\t/g, ' ').trim();
  // Escape backslashes first, then table delimiters, so input like `\|` remains
  // faithfully represented and cannot interfere with Markdown table structure.
  text = text.replace(/\\/g, '\\\\');
  text = text.replace(/\|/g, '\\|');
  if (text.length > MAX_CELL_CHARS) text = `${text.slice(0, MAX_CELL_CHARS - 1)}…`;
  return text;
}

/**
 * Compute the inclusive used column span for a worksheet. ExcelJS `columnCount`
 * can over-report from stray formatting, so we widen to the actual last cell
 * that carries text on any row — keeping empty trailing columns out of the grid.
 */
function usedColumnCount(sheet: ExcelJS.Worksheet): number {
  let maxCol = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // `cellCount` is the last cell with a value on this row (1-indexed).
    if (row.cellCount > maxCol) maxCol = row.cellCount;
  });
  return maxCol;
}

/** A Markdown header label for a column whose header cell is blank. */
function fallbackHeader(colIndex: number): string {
  return `col${colIndex}`;
}

/**
 * Render a single worksheet as a Markdown section. Returns the text plus whether
 * the budget cut it short (so the caller can record one aggregate warning). The
 * first non-empty row is treated as the header row — a faithful visual choice,
 * not a semantic one; the agent decides whether row 1 is really a header.
 */
function renderSheet(
  sheet: ExcelJS.Worksheet,
  charBudget: number
): { text: string; truncated: boolean; rendered: boolean } {
  const colCount = usedColumnCount(sheet);
  const name = sheet.name.trim() || `Sheet ${sheet.id}`;

  if (colCount === 0) {
    return { text: `## Sheet: ${name}\n\n_(empty)_`, truncated: false, rendered: false };
  }

  const lines: string[] = [`## Sheet: ${name}`, ''];
  let headerEmitted = false;
  let truncated = false;
  let stop = false;
  let used = lines.join('\n').length;

  // Stream rows: the first non-empty row becomes the header, the rest become body
  // rows. We stop converting cells to text once the budget is spent so a
  // pathological sheet (100k rows) can't materialise the whole grid in memory —
  // `eachRow` still iterates, but the per-cell work is skipped after `stop`.
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (stop) return;

    const cells: string[] = [];
    let anyContent = false;
    for (let c = 1; c <= colCount; c += 1) {
      const value = cellToText(row.getCell(c));
      if (value.length > 0) anyContent = true;
      cells.push(value);
    }
    if (!anyContent) return; // skip fully-blank rows

    if (!headerEmitted) {
      // Blank header cells get a stable label so the table stays well-formed and
      // every column is referenceable. The header is emitted unconditionally
      // (one row) even if it alone exceeds the budget — a sheet is represented by
      // at least its columns; the budget is a soft cap on body volume.
      const headers = cells.map((h, i) => (h.length > 0 ? h : fallbackHeader(i + 1)));
      lines.push(`| ${headers.join(' | ')} |`);
      lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
      used = lines.join('\n').length;
      headerEmitted = true;
      return;
    }

    const line = `| ${cells.join(' | ')} |`;
    if (used + line.length + 1 > charBudget) {
      truncated = true;
      stop = true;
      return;
    }
    lines.push(line);
    used += line.length + 1;
  });

  // No non-empty row → the sheet had columns by `cellCount` but no real content.
  if (!headerEmitted) {
    return { text: `## Sheet: ${name}\n\n_(empty)_`, truncated: false, rendered: false };
  }

  return { text: lines.join('\n'), truncated, rendered: true };
}

/**
 * Flatten an `.xlsx` workbook buffer into a {@link ParsedDocument} whose
 * `fullText` is the faithful Markdown rendering of every tab. Throws when the
 * buffer is not a readable workbook (the ingest pipeline maps that to a 422
 * PARSE_FAILED, same as the other parsers).
 *
 * @param buffer   Raw upload bytes.
 * @param fileName Original file name (used for the derived title fallback).
 */
export async function flattenWorkbook(
  buffer: Buffer,
  fileName: string,
  opts: FlattenWorkbookOptions = {}
): Promise<ParsedDocument> {
  const maxChars = opts.maxChars ?? MAX_FLATTENED_CHARS;

  const workbook = new ExcelJS.Workbook();
  // exceljs declares its own `Buffer` type, structurally identical to Node's at
  // runtime but nominally distinct to tsc. This is a library type-bridge, not a
  // validation bypass: `load()` parses + validates the bytes itself and throws on
  // anything that isn't a real workbook (mapped to 422 PARSE_FAILED upstream).
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sections: ParsedSection[] = [];
  const blocks: string[] = [];
  const warnings: string[] = [];
  const emptySheets: string[] = [];
  const truncatedSheets: string[] = [];

  let order = 0;
  let remaining = maxChars;
  let renderedAny = false;

  workbook.eachSheet((sheet) => {
    const name = sheet.name.trim() || `Sheet ${sheet.id}`;

    if (remaining <= 0) {
      truncatedSheets.push(name);
      return;
    }

    const { text, truncated, rendered } = renderSheet(sheet, remaining);
    if (rendered) {
      renderedAny = true;
    } else {
      emptySheets.push(name);
      // Still emit the placeholder block so the agent sees the tab existed.
    }
    if (truncated) truncatedSheets.push(name);

    blocks.push(text);
    sections.push({ title: name, content: text, order });
    order += 1;
    remaining -= text.length + 2; // +2 for the joining blank line
  });

  if (emptySheets.length > 0) {
    warnings.push(`Empty sheet(s) with no cell content: ${emptySheets.join(', ')}.`);
  }
  if (truncatedSheets.length > 0) {
    warnings.push(
      `Flattened text reached the ${maxChars.toLocaleString()}-character cap; ` +
        `content was truncated in: ${[...new Set(truncatedSheets)].join(', ')}.`
    );
  }

  // When NO sheet had real content (a blank or template workbook), the only
  // blocks are `_(empty)_` placeholders. Returning them verbatim would make
  // `fullText` non-empty and slip past the ingest pipeline's EMPTY_DOCUMENT
  // guard, silently creating a zero-question questionnaire. Collapse to empty so
  // that guard fires; the per-sheet warnings still record what was seen.
  const fullText = renderedAny ? blocks.join('\n\n') : '';

  // Title: prefer the workbook's document-properties title, else let the caller
  // fall back to the file name (it calls deriveTitle). We never guess a title
  // from sheet contents — that's an editorial call the agent/admin owns.
  const propsTitle = typeof workbook.title === 'string' ? workbook.title.trim() : '';

  return {
    title: propsTitle,
    sections,
    fullText,
    metadata: {
      format: 'xlsx',
      sheetCount: String(sections.length),
      fileName,
    },
    warnings,
  };
}
