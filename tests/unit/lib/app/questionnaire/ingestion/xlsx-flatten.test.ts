import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';

import {
  flattenWorkbook,
  MAX_FLATTENED_CHARS,
} from '@/lib/app/questionnaire/ingestion/xlsx-flatten';

/**
 * Tests for the spreadsheet flattener — the one deterministic step in
 * spreadsheet ingestion. Its contract is "faithful workbook → Markdown": every
 * tab, every used column (ID/FK columns included), no question/structure
 * decisions. Fixtures are built in-memory with exceljs (no external file) and
 * mirror the relational shape the agent has to read (a question tab that
 * references a section tab by id).
 */

/** Build an .xlsx buffer from `{ sheetName: rows }`, rows as arrays of cell values. */
async function buildXlsx(sheets: Record<string, (string | number | boolean)[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

const RELATIONAL_FIXTURE = {
  Sections: [
    ['SectionID', 'Section Name', 'Description'],
    ['strategy', 'Strategy', 'Growth strategy and planning'],
    ['talent', 'Talent', 'Recruiting and enablement'],
  ],
  Activities: [
    ['SubsectionID', 'Ref', 'Description', 'Type'],
    ['strategy', '800', 'HPE salespeople introduce the strategy in conversations.', 'likertscale'],
    ['talent', '801', 'Please add comments to support your scores.', 'comment'],
  ],
};

describe('flattenWorkbook — faithful rendering', () => {
  it('renders every tab as its own Markdown section in workbook order', async () => {
    const buf = await buildXlsx(RELATIONAL_FIXTURE);
    const doc = await flattenWorkbook(buf, 'survey.xlsx');

    expect(doc.sections.map((s) => s.title)).toEqual(['Sections', 'Activities']);
    expect(doc.fullText).toContain('## Sheet: Sections');
    expect(doc.fullText).toContain('## Sheet: Activities');
    // Section order in the text matches the workbook order.
    expect(doc.fullText.indexOf('## Sheet: Sections')).toBeLessThan(
      doc.fullText.indexOf('## Sheet: Activities')
    );
  });

  it('preserves the header row and every column, including ID/FK columns', async () => {
    const buf = await buildXlsx(RELATIONAL_FIXTURE);
    const doc = await flattenWorkbook(buf, 'survey.xlsx');

    // The foreign-key columns that wire the tabs together must survive — they are
    // what lets the agent join Activities → Sections.
    expect(doc.fullText).toContain('| SectionID | Section Name | Description |');
    expect(doc.fullText).toContain('| SubsectionID | Ref | Description | Type |');
    // A Markdown header separator row is emitted so the table is well-formed.
    expect(doc.fullText).toMatch(/\| --- \| --- \| --- \| --- \|/);
  });

  it('renders cell content verbatim (incl. brand terms the agent may be told to rewrite)', async () => {
    const buf = await buildXlsx(RELATIONAL_FIXTURE);
    const doc = await flattenWorkbook(buf, 'survey.xlsx');
    expect(doc.fullText).toContain('HPE salespeople introduce the strategy in conversations.');
    // The type column is preserved as an answer-type hint for the agent.
    expect(doc.fullText).toContain('likertscale');
    expect(doc.fullText).toContain('comment');
  });

  it('marks the format and sheet count in metadata', async () => {
    const buf = await buildXlsx(RELATIONAL_FIXTURE);
    const doc = await flattenWorkbook(buf, 'survey.xlsx');
    expect(doc.metadata.format).toBe('xlsx');
    expect(doc.metadata.sheetCount).toBe('2');
  });
});

describe('flattenWorkbook — edge cases', () => {
  it('escapes pipe characters so a cell value cannot break the column grid', async () => {
    const buf = await buildXlsx({
      Q: [['Prompt'], ['Rate this A | B | C scale']],
    });
    const doc = await flattenWorkbook(buf, 'q.xlsx');
    expect(doc.fullText).toContain('Rate this A \\| B \\| C scale');
  });

  it('collapses intra-cell newlines to keep a row on one line', async () => {
    const buf = await buildXlsx({ Q: [['Prompt'], ['line one\nline two']] });
    const doc = await flattenWorkbook(buf, 'q.xlsx');
    expect(doc.fullText).toContain('line one line two');
    expect(doc.fullText).not.toContain('line one\nline two');
  });

  it('records an empty sheet as a warning rather than failing', async () => {
    const buf = await buildXlsx({
      Empty: [],
      Data: [['H'], ['v']],
    });
    const doc = await flattenWorkbook(buf, 'q.xlsx');
    expect(doc.warnings.some((w) => /Empty sheet/i.test(w))).toBe(true);
    // The non-empty sheet is still rendered.
    expect(doc.fullText).toContain('## Sheet: Data');
  });

  it('yields empty fullText for an all-empty workbook so the EMPTY_DOCUMENT guard fires', async () => {
    // No sheet has real content — placeholders alone must NOT make fullText
    // non-empty, or the ingest pipeline would skip its empty-document 422 and
    // create a zero-question questionnaire.
    const buf = await buildXlsx({ Sheet1: [], Sheet2: [] });
    const doc = await flattenWorkbook(buf, 'blank.xlsx');
    expect(doc.fullText.trim()).toBe('');
    expect(doc.warnings.some((w) => /Empty sheet/i.test(w))).toBe(true);
  });

  it('truncates past the char budget and warns instead of silently dropping rows', async () => {
    const maxChars = 400;
    const rows: string[][] = [['Prompt']];
    for (let i = 0; i < 50; i += 1) rows.push([`Question number ${i} ${'x'.repeat(50)}`]);
    const buf = await buildXlsx({ Big: rows });

    const doc = await flattenWorkbook(buf, 'big.xlsx', { maxChars });
    // A single sheet never exceeds the budget: renderSheet stops before appending
    // any body row that would cross it, so the output is bounded by maxChars exactly.
    expect(doc.fullText.length).toBeLessThanOrEqual(maxChars);
    expect(doc.warnings.some((w) => /cap/i.test(w))).toBe(true);
  });

  it('labels a blank header cell with a stable col<n> placeholder so the table stays well-formed', async () => {
    const buf = await buildXlsx({
      S: [
        ['Ref', '', 'Prompt'],
        ['800', 'x', 'How are you?'],
      ],
    });
    const doc = await flattenWorkbook(buf, 's.xlsx');
    expect(doc.fullText).toContain('| Ref | col2 | Prompt |');
  });

  it('uses the workbook document-properties title when present', async () => {
    const wb = new ExcelJS.Workbook();
    wb.title = 'Sales Enablement Survey';
    const ws = wb.addWorksheet('Q');
    ws.addRow(['Prompt']);
    ws.addRow(['How are you?']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const doc = await flattenWorkbook(buf, 'fallback-name.xlsx');
    expect(doc.title).toBe('Sales Enablement Survey');
  });

  it('skips an entire later sheet once the budget is spent and names it in the warning', async () => {
    const buf = await buildXlsx({
      First: [['Header'], ['a fairly long first-sheet value that exhausts the budget']],
      Second: [['Header'], ['this sheet should be skipped wholesale']],
    });

    const doc = await flattenWorkbook(buf, 'two.xlsx', { maxChars: 20 });
    expect(doc.fullText).toContain('## Sheet: First');
    expect(doc.fullText).not.toContain('## Sheet: Second');
    expect(doc.warnings.some((w) => /cap/i.test(w) && /Second/.test(w))).toBe(true);
  });

  it('throws on a buffer that is not a readable workbook', async () => {
    await expect(flattenWorkbook(Buffer.from('not a workbook'), 'bad.xlsx')).rejects.toThrow();
  });

  it('exposes the documented default budget (~150k tokens)', () => {
    expect(MAX_FLATTENED_CHARS).toBe(600_000);
  });
});
