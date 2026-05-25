/**
 * Unit tests for the heuristic graders.
 *
 * One describe block per grader, each covering: happy path,
 * miss path, and any reference-required/config edge cases. Mocks are
 * unnecessary — heuristic graders are pure functions over their input.
 */

import { describe, it, expect } from 'vitest';

import { exactMatchGrader } from '@/lib/orchestration/evaluations/graders/heuristic/exact-match';
import { containsGrader } from '@/lib/orchestration/evaluations/graders/heuristic/contains';
import { regexGrader } from '@/lib/orchestration/evaluations/graders/heuristic/regex';
import { lengthBetweenGrader } from '@/lib/orchestration/evaluations/graders/heuristic/length-between';
import { jsonSchemaGrader } from '@/lib/orchestration/evaluations/graders/heuristic/json-schema';
import { jsonPathEqualsGrader } from '@/lib/orchestration/evaluations/graders/heuristic/json-path-equals';
import { toolWasCalledGrader } from '@/lib/orchestration/evaluations/graders/heuristic/tool-was-called';
import { citationCountAtLeastGrader } from '@/lib/orchestration/evaluations/graders/heuristic/citation-count-at-least';

function input(overrides: Record<string, unknown> = {}): {
  userInput: string;
  modelOutput: string;
  config: unknown;
  [k: string]: unknown;
} {
  return {
    userInput: 'q',
    modelOutput: '',
    config: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// exact_match
// ---------------------------------------------------------------------------

describe('exact_match grader', () => {
  it('passes on byte-for-byte equality (default trim=on)', async () => {
    const r = await exactMatchGrader.grade({
      ...input({ modelOutput: 'yes', expectedOutput: 'yes' }),
      config: { trim: true, caseInsensitive: false },
    });
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  it('trims whitespace by default', async () => {
    const r = await exactMatchGrader.grade({
      ...input({ modelOutput: '  yes\n', expectedOutput: 'yes' }),
      config: { trim: true, caseInsensitive: false },
    });
    expect(r.score).toBe(1);
  });

  it('fails on case difference when caseInsensitive=false', async () => {
    const r = await exactMatchGrader.grade({
      ...input({ modelOutput: 'YES', expectedOutput: 'yes' }),
      config: { trim: true, caseInsensitive: false },
    });
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('returns null score when expectedOutput is missing', async () => {
    const r = await exactMatchGrader.grade({
      ...input({ modelOutput: 'yes' }),
      config: { trim: true, caseInsensitive: false },
    });
    expect(r.score).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// contains
// ---------------------------------------------------------------------------

describe('contains grader', () => {
  it('finds the needle case-insensitively by default', async () => {
    const r = await containsGrader.grade({
      ...input({ modelOutput: 'The total is £45.00.', expectedOutput: '£45' }),
      config: { caseInsensitive: true },
    });
    expect(r.passed).toBe(true);
  });

  it('respects case sensitivity when configured', async () => {
    const r = await containsGrader.grade({
      ...input({ modelOutput: 'hello world', expectedOutput: 'WORLD' }),
      config: { caseInsensitive: false },
    });
    expect(r.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// regex
// ---------------------------------------------------------------------------

describe('regex grader', () => {
  it('matches ISO dates with a permissive pattern', async () => {
    const r = await regexGrader.grade({
      ...input({ modelOutput: 'Due: 2026-05-25' }),
      config: { pattern: '\\d{4}-\\d{2}-\\d{2}', flags: '' },
    });
    expect(r.passed).toBe(true);
  });

  it('reports invalid regex without throwing', async () => {
    const r = await regexGrader.grade({
      ...input({ modelOutput: 'x' }),
      config: { pattern: '(', flags: '' },
    });
    expect(r.score).toBeNull();
    expect(r.reasoning).toMatch(/Invalid regex/);
  });
});

// ---------------------------------------------------------------------------
// length_between
// ---------------------------------------------------------------------------

describe('length_between grader', () => {
  it('passes in-range outputs', async () => {
    const r = await lengthBetweenGrader.grade({
      ...input({ modelOutput: 'x'.repeat(50) }),
      config: { min: 10, max: 100 },
    });
    expect(r.passed).toBe(true);
  });

  it('fails when too short', async () => {
    const r = await lengthBetweenGrader.grade({
      ...input({ modelOutput: 'x' }),
      config: { min: 10, max: 100 },
    });
    expect(r.passed).toBe(false);
  });

  it('fails when too long', async () => {
    const r = await lengthBetweenGrader.grade({
      ...input({ modelOutput: 'x'.repeat(200) }),
      config: { min: 10, max: 100 },
    });
    expect(r.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// json_schema
// ---------------------------------------------------------------------------

describe('json_schema grader', () => {
  it('passes when all required fields are present with correct types', async () => {
    const r = await jsonSchemaGrader.grade({
      ...input({ modelOutput: JSON.stringify({ name: 'a', count: 3 }) }),
      config: { fields: { name: 'string', count: 'number' }, strict: false },
    });
    expect(r.passed).toBe(true);
  });

  it('fails on missing required field', async () => {
    const r = await jsonSchemaGrader.grade({
      ...input({ modelOutput: JSON.stringify({ name: 'a' }) }),
      config: { fields: { name: 'string', count: 'number' }, strict: false },
    });
    expect(r.passed).toBe(false);
    expect(r.reasoning).toMatch(/count/);
  });

  it('treats `?`-suffixed fields as optional', async () => {
    const r = await jsonSchemaGrader.grade({
      ...input({ modelOutput: JSON.stringify({ name: 'a' }) }),
      config: { fields: { name: 'string', 'count?': 'number' }, strict: false },
    });
    expect(r.passed).toBe(true);
  });

  it('strict mode rejects extra keys', async () => {
    const r = await jsonSchemaGrader.grade({
      ...input({ modelOutput: JSON.stringify({ name: 'a', extra: true }) }),
      config: { fields: { name: 'string' }, strict: true },
    });
    expect(r.passed).toBe(false);
    expect(r.reasoning).toMatch(/extra/);
  });

  it('fails when output is not JSON', async () => {
    const r = await jsonSchemaGrader.grade({
      ...input({ modelOutput: 'sorry I cannot do that' }),
      config: { fields: {}, strict: false },
    });
    expect(r.passed).toBe(false);
    expect(r.reasoning).toMatch(/not valid JSON/i);
  });
});

// ---------------------------------------------------------------------------
// json_path_equals
// ---------------------------------------------------------------------------

describe('json_path_equals grader', () => {
  it('reads a deep path correctly', async () => {
    const r = await jsonPathEqualsGrader.grade({
      ...input({ modelOutput: JSON.stringify({ user: { email: 'a@b' } }) }),
      config: { path: 'user.email', value: 'a@b' },
    });
    expect(r.passed).toBe(true);
  });

  it('reads array indices via [N] syntax', async () => {
    const r = await jsonPathEqualsGrader.grade({
      ...input({ modelOutput: JSON.stringify({ items: [{ sku: 'ABC' }] }) }),
      config: { path: 'items[0].sku', value: 'ABC' },
    });
    expect(r.passed).toBe(true);
  });

  it('fails when the value differs', async () => {
    const r = await jsonPathEqualsGrader.grade({
      ...input({ modelOutput: JSON.stringify({ status: 'ok' }) }),
      config: { path: 'status', value: 'error' },
    });
    expect(r.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tool_was_called
// ---------------------------------------------------------------------------

describe('tool_was_called grader', () => {
  it('passes when the named tool was invoked', async () => {
    const r = await toolWasCalledGrader.grade({
      ...input({ toolCalls: [{ slug: 'search_knowledge_base' }] }),
      config: { slug: 'search_knowledge_base', min: 1 },
    });
    expect(r.passed).toBe(true);
  });

  it('fails when the tool is missing', async () => {
    const r = await toolWasCalledGrader.grade({
      ...input({ toolCalls: [{ slug: 'send_message' }] }),
      config: { slug: 'search_knowledge_base', min: 1 },
    });
    expect(r.passed).toBe(false);
  });

  it('respects min for repeated calls', async () => {
    const r = await toolWasCalledGrader.grade({
      ...input({
        toolCalls: [{ slug: 'search_knowledge_base' }, { slug: 'search_knowledge_base' }],
      }),
      config: { slug: 'search_knowledge_base', min: 3 },
    });
    expect(r.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// citation_count_at_least
// ---------------------------------------------------------------------------

describe('citation_count_at_least grader', () => {
  it('passes when citations meet the minimum', async () => {
    const r = await citationCountAtLeastGrader.grade({
      ...input({
        citations: [
          {
            marker: 1,
            chunkId: 'c1',
            documentId: 'd1',
            excerpt: 'e',
            similarity: 0.9,
            documentName: 'Doc',
            section: null,
          },
        ],
      }),
      config: { min: 1 },
    });
    expect(r.passed).toBe(true);
  });

  it('fails when no citations were emitted', async () => {
    const r = await citationCountAtLeastGrader.grade({
      ...input({ citations: [] }),
      config: { min: 1 },
    });
    expect(r.passed).toBe(false);
  });
});
