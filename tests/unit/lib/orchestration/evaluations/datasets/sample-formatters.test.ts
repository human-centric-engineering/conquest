/**
 * Unit tests for sample-formatters — samplesToCsv and samplesToJsonl.
 *
 * Coverage:
 * - CSV: RFC 4180 quoting (quotes, commas, newlines inside cells)
 * - CSV: empty cell → empty string
 * - CSV: all optional fields set → all 5 columns populated
 * - CSV: only input → other columns empty
 * - JSONL: tags string folded into metadata.tags array (comma-split, trimmed, empties dropped)
 * - JSONL: empty tags → no metadata.tags key
 * - JSONL: referenceCitations only included when set
 * - JSONL: expectedOutput: undefined → no key in output
 * - Round-trip CSV: samplesToCsv → parseDatasetCsv → same case shape
 * - Round-trip JSONL: samplesToJsonl → parseDatasetJsonl → same case shape
 *
 * @see lib/orchestration/evaluations/datasets/sample-formatters.ts
 */

import { describe, it, expect } from 'vitest';
import {
  samplesToCsv,
  samplesToJsonl,
} from '@/lib/orchestration/evaluations/datasets/sample-formatters';
import { parseDatasetCsv } from '@/lib/orchestration/evaluations/datasets/parsers/csv-parser';
import { parseDatasetJsonl } from '@/lib/orchestration/evaluations/datasets/parsers/jsonl-parser';
import type { DatasetSampleCase } from '@/components/admin/orchestration/evaluations-foundations/help-text';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSample(overrides: Partial<DatasetSampleCase> = {}): DatasetSampleCase {
  return {
    input: 'What is the return window?',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// samplesToCsv — cell quoting (RFC 4180)
// ---------------------------------------------------------------------------

describe('samplesToCsv — RFC 4180 quoting', () => {
  it('quotes cells that contain a double-quote character (gap 33)', () => {
    const csv = samplesToCsv([makeSample({ input: 'He said "hello"' })]);
    // The input cell value contains " — must be wrapped and escaped
    expect(csv).toContain('"He said ""hello"""');
  });

  it('quotes cells that contain a comma (gap 34)', () => {
    const csv = samplesToCsv([makeSample({ input: 'first, second' })]);
    expect(csv).toContain('"first, second"');
  });

  it('quotes cells that contain a newline (gap 35)', () => {
    const csv = samplesToCsv([makeSample({ input: 'line one\nline two' })]);
    expect(csv).toContain('"line one\nline two"');
  });

  it('empty cell value → stored as empty string, not quoted empty (gap 36)', () => {
    // A sample with no expectedOutput — the expectedOutput cell should be
    // empty (not `""`), because quoteCsvCell('') returns ''.
    const csv = samplesToCsv([makeSample()]);
    // Parse the second column of the first data row
    const lines = csv.split('\n');
    const dataRow = lines[1]; // index 0 is header
    // Split the raw row on commas (only works because our test input has no
    // commas/quotes in the input cell value itself)
    const cells = dataRow.split(',');
    // expectedOutput is column index 1
    expect(cells[1]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// samplesToCsv — column population
// ---------------------------------------------------------------------------

describe('samplesToCsv — column population', () => {
  it('all optional fields set → all 5 columns populated in the data row (gap 37)', () => {
    const sample: DatasetSampleCase = {
      input: 'Q?',
      expectedOutput: 'A.',
      metadata: { category: 'policy' },
      tags: 'returns, policy',
      referenceCitations: [{ title: 'Policy.pdf', uri: 'https://example.com' }],
    };
    const csv = samplesToCsv([sample]);
    const lines = csv.split('\n');
    // Header row
    expect(lines[0]).toBe('input,expectedOutput,metadata,tags,referenceCitations');
    // Data row: all 5 cells populated (no trailing empty cells)
    const dataRow = lines[1];
    // Verify the row does not end with empty commas (i.e. all columns filled)
    expect(dataRow).not.toMatch(/,+$/);
    expect(dataRow).toContain('returns, policy');
  });

  it('only input set → expectedOutput, metadata, tags, referenceCitations cells are all empty (gap 38)', () => {
    const csv = samplesToCsv([makeSample()]);
    const lines = csv.split('\n');
    const dataRow = lines[1];
    // With only `input` set, cells 1–4 must be empty → row ends in four commas
    expect(dataRow).toMatch(/,,,$/);
  });
});

// ---------------------------------------------------------------------------
// samplesToCsv — structure
// ---------------------------------------------------------------------------

describe('samplesToCsv — structure', () => {
  it('header row is always the 5-column canonical header', () => {
    const csv = samplesToCsv([makeSample()]);
    expect(csv.split('\n')[0]).toBe('input,expectedOutput,metadata,tags,referenceCitations');
  });

  it('produces one data row per sample plus a trailing newline', () => {
    const csv = samplesToCsv([makeSample(), makeSample({ input: 'Second Q?' })]);
    const lines = csv.split('\n');
    // header + 2 data rows + trailing empty from the final \n
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// samplesToJsonl — tags handling
// ---------------------------------------------------------------------------

describe('samplesToJsonl — tags field', () => {
  it('tags string is folded into metadata.tags as a trimmed, comma-split array (gap 39)', () => {
    const jsonl = samplesToJsonl([makeSample({ tags: 'returns, policy, edge-case' })]);
    const parsed = JSON.parse(jsonl.trim()) as { metadata?: { tags?: string[] } };
    expect(parsed.metadata?.tags).toEqual(['returns', 'policy', 'edge-case']);
  });

  it('empty tags string → no metadata.tags key in output (gap 40)', () => {
    const jsonl = samplesToJsonl([makeSample({ tags: '' })]);
    const parsed = JSON.parse(jsonl.trim()) as { metadata?: { tags?: string[] } };
    // tags='' → split on comma → [''] → filter(t=>t.length>0) → [] → empty
    // → metadata.tags is NOT set (array length === 0 means the block is skipped)
    expect(parsed.metadata).toBeUndefined();
    // or if metadata exists from other fields, tags should not be present
    if (parsed.metadata) {
      expect(parsed.metadata).not.toHaveProperty('tags');
    }
  });

  it('tags with leading/trailing whitespace inside entries are trimmed (corollary)', () => {
    const jsonl = samplesToJsonl([makeSample({ tags: '  alpha , beta  ,  gamma ' })]);
    const parsed = JSON.parse(jsonl.trim()) as { metadata?: { tags?: string[] } };
    expect(parsed.metadata?.tags).toEqual(['alpha', 'beta', 'gamma']);
  });
});

// ---------------------------------------------------------------------------
// samplesToJsonl — optional fields
// ---------------------------------------------------------------------------

describe('samplesToJsonl — optional field handling', () => {
  it('referenceCitations only included in output when set (gap 41)', () => {
    const withCitations = samplesToJsonl([
      makeSample({
        referenceCitations: [{ title: 'Doc', uri: 'https://example.com' }],
      }),
    ]);
    const withoutCitations = samplesToJsonl([makeSample()]);

    const parsedWith = JSON.parse(withCitations.trim()) as {
      referenceCitations?: unknown[];
    };
    const parsedWithout = JSON.parse(withoutCitations.trim()) as {
      referenceCitations?: unknown[];
    };

    expect(parsedWith.referenceCitations).toEqual([{ title: 'Doc', uri: 'https://example.com' }]);
    expect(parsedWithout).not.toHaveProperty('referenceCitations');
  });

  it('expectedOutput: undefined → no key in JSONL output (gap 42)', () => {
    const jsonl = samplesToJsonl([makeSample()]); // no expectedOutput
    const parsed = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('expectedOutput');
  });

  it('expectedOutput: defined → present in JSONL output', () => {
    const jsonl = samplesToJsonl([makeSample({ expectedOutput: 'The answer.' })]);
    const parsed = JSON.parse(jsonl.trim()) as { expectedOutput?: string };
    expect(parsed.expectedOutput).toBe('The answer.');
  });

  it('produces one JSON object per line with a trailing newline', () => {
    const jsonl = samplesToJsonl([
      makeSample({ input: 'First?' }),
      makeSample({ input: 'Second?' }),
    ]);
    const lines = jsonl.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(jsonl.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: samplesToCsv → parseDatasetCsv (gap 43)
// ---------------------------------------------------------------------------

describe('samplesToCsv → parseDatasetCsv round-trip (gap 43)', () => {
  it('full sample with expectedOutput, metadata, tags → re-parses to equal case (minus tags→metadata.tags fold)', () => {
    const sample: DatasetSampleCase = {
      input: 'What is the return window for online orders?',
      expectedOutput: '30 days from delivery.',
      metadata: { category: 'policy' },
      tags: 'returns, policy',
    };

    const csv = samplesToCsv([sample]);
    const { cases } = parseDatasetCsv(csv);

    expect(cases).toHaveLength(1);
    const c = cases[0];

    // input and expectedOutput must round-trip cleanly
    expect(c.input).toBe(sample.input);
    expect(c.expectedOutput).toBe(sample.expectedOutput);

    // tags fold: 'returns, policy' → metadata.tags = ['returns', 'policy']
    // Also metadata from the metadata column merges in
    expect(c.metadata?.tags).toEqual(['returns', 'policy']);
    expect(c.metadata?.category).toBe('policy');
  });

  it('sample with referenceCitations array → round-trips through CSV correctly', () => {
    const sample: DatasetSampleCase = {
      input: 'Can I get a refund?',
      expectedOutput: 'Yes, within 14 days.',
      referenceCitations: [{ title: 'Returns Policy', uri: 'https://example.com/returns' }],
    };

    const csv = samplesToCsv([sample]);
    const { cases } = parseDatasetCsv(csv);

    expect(cases[0].referenceCitations).toEqual(sample.referenceCitations);
  });

  it('sample with quotes in input round-trips without corruption', () => {
    const sample: DatasetSampleCase = {
      input: 'He asked: "What is the refund window?"',
    };

    const csv = samplesToCsv([sample]);
    const { cases } = parseDatasetCsv(csv);

    expect(cases[0].input).toBe(sample.input);
  });

  it('sample with commas in input round-trips without corruption', () => {
    const sample: DatasetSampleCase = {
      input: 'Refunds, exchanges, and store credit — which applies?',
    };

    const csv = samplesToCsv([sample]);
    const { cases } = parseDatasetCsv(csv);

    expect(cases[0].input).toBe(sample.input);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: samplesToJsonl → parseDatasetJsonl (gap 44)
// ---------------------------------------------------------------------------

describe('samplesToJsonl → parseDatasetJsonl round-trip (gap 44)', () => {
  it('full sample with expectedOutput and tags → re-parses to equal case (tags folded into metadata.tags)', () => {
    const sample: DatasetSampleCase = {
      input: 'Can I return an opened item?',
      expectedOutput: 'Yes within 14 days if faulty.',
      tags: 'returns, edge-case',
    };

    const jsonl = samplesToJsonl([sample]);
    const { cases } = parseDatasetJsonl(jsonl);

    expect(cases).toHaveLength(1);
    const c = cases[0];

    expect(c.input).toBe(sample.input);
    expect(c.expectedOutput).toBe(sample.expectedOutput);
    // tags must be folded into metadata.tags
    expect(c.metadata?.tags).toEqual(['returns', 'edge-case']);
  });

  it('sample with referenceCitations → round-trips correctly', () => {
    const sample: DatasetSampleCase = {
      input: 'Order arrived damaged. What do I do?',
      referenceCitations: [{ title: 'Damage Claims', uri: 'https://example.com/claims' }],
    };

    const jsonl = samplesToJsonl([sample]);
    const { cases } = parseDatasetJsonl(jsonl);

    expect(cases[0].referenceCitations).toEqual(sample.referenceCitations);
  });

  it('sample with metadata object → round-trips correctly', () => {
    const sample: DatasetSampleCase = {
      input: 'How do I file a claim?',
      metadata: { intent: 'damage_claim', priority: 'high' },
    };

    const jsonl = samplesToJsonl([sample]);
    const { cases } = parseDatasetJsonl(jsonl);

    expect(cases[0].metadata).toMatchObject({ intent: 'damage_claim', priority: 'high' });
  });

  it('multiple samples → all round-trip correctly', () => {
    const samples: DatasetSampleCase[] = [
      { input: 'First question?', expectedOutput: 'First answer.' },
      { input: 'Second question?', tags: 'tag-a' },
    ];

    const jsonl = samplesToJsonl(samples);
    const { cases } = parseDatasetJsonl(jsonl);

    expect(cases).toHaveLength(2);
    expect(cases[0].input).toBe('First question?');
    expect(cases[0].expectedOutput).toBe('First answer.');
    expect(cases[1].input).toBe('Second question?');
    expect(cases[1].metadata?.tags).toEqual(['tag-a']);
  });
});
