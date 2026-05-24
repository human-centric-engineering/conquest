import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpExposedPrompt: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import {
  listMcpPrompts,
  getMcpPrompt,
  clearMcpPromptCache,
} from '@/lib/orchestration/mcp/prompt-registry';
import { prisma } from '@/lib/db/client';

const findManyMock = vi.mocked(prisma.mcpExposedPrompt.findMany);

function mockDbPrompts(rows: Array<Record<string, unknown>>): void {
  findManyMock.mockResolvedValue(rows as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMcpPromptCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy fallback — applies when the DB is empty (fresh install pre-seed)
// ─────────────────────────────────────────────────────────────────────────────

describe('legacy built-in fallback', () => {
  beforeEach(() => mockDbPrompts([]));

  it('returns the 2 legacy built-ins when the DB has no rows', async () => {
    const prompts = await listMcpPrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts.map((p) => p.name).sort()).toEqual(['analyze-pattern', 'search-knowledge']);
  });

  it('analyze-pattern fallback renders the pattern number', async () => {
    const messages = await getMcpPrompt('analyze-pattern', { pattern_number: 7 });
    expect(messages?.[0].content.text).toContain('#7');
  });

  it('analyze-pattern fallback rejects out-of-range pattern_number', async () => {
    const messages = await getMcpPrompt('analyze-pattern', { pattern_number: 99 });
    expect(messages?.[0].content.text).toContain('Invalid');
  });

  it('search-knowledge fallback includes query verbatim', async () => {
    const messages = await getMcpPrompt('search-knowledge', { query: 'orchestration' });
    expect(messages?.[0].content.text).toContain('orchestration');
  });

  it('returns null for an unknown prompt name', async () => {
    const result = await getMcpPrompt('does-not-exist', {});
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB-backed prompts — admin-editable, take precedence over fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('DB-backed prompts', () => {
  it('lists prompts loaded from the DB', async () => {
    mockDbPrompts([
      {
        name: 'custom-prompt',
        description: 'A custom admin-created prompt',
        template: 'hello {{name}}',
        argumentsSpec: [{ name: 'name', description: 'who', required: true }],
      },
    ]);
    const prompts = await listMcpPrompts();
    // 1 DB + 2 fallbacks (none collide with the custom name)
    expect(prompts).toHaveLength(3);
    const custom = prompts.find((p) => p.name === 'custom-prompt');
    expect(custom?.description).toBe('A custom admin-created prompt');
    expect(custom?.arguments?.[0].required).toBe(true);
  });

  it('DB rows take precedence over legacy fallback for the same name', async () => {
    mockDbPrompts([
      {
        name: 'analyze-pattern',
        description: 'Overridden by admin',
        template: 'Overridden body for pattern {{pattern_number}}',
        argumentsSpec: [{ name: 'pattern_number', description: 'pattern number', required: true }],
      },
    ]);
    const messages = await getMcpPrompt('analyze-pattern', { pattern_number: 5 });
    expect(messages?.[0].content.text).toBe('Overridden body for pattern 5');
  });

  it('substitutes only declared argument names', async () => {
    // {{database_url}} is not in argumentsSpec — must render literally,
    // not be evaluated against any argument or server state.
    mockDbPrompts([
      {
        name: 'safe-test',
        description: 'safety test',
        template: 'declared={{name}} undeclared={{database_url}}',
        argumentsSpec: [{ name: 'name', description: 'name', required: true }],
      },
    ]);
    const messages = await getMcpPrompt('safe-test', {
      name: 'alice',
      database_url: 'postgres://leaked',
    });
    expect(messages?.[0].content.text).toBe('declared=alice undeclared={{database_url}}');
  });

  it('tolerates whitespace inside placeholders', async () => {
    mockDbPrompts([
      {
        name: 'ws-test',
        description: 'ws',
        template: '{{ name }}',
        argumentsSpec: [{ name: 'name', description: 'n', required: false }],
      },
    ]);
    const messages = await getMcpPrompt('ws-test', { name: 'ok' });
    expect(messages?.[0].content.text).toBe('ok');
  });

  it('renders undefined optional args as empty strings', async () => {
    mockDbPrompts([
      {
        name: 'opt-test',
        description: 'opt',
        template: 'before/{{maybe}}/after',
        argumentsSpec: [{ name: 'maybe', description: 'optional', required: false }],
      },
    ]);
    const messages = await getMcpPrompt('opt-test', {});
    expect(messages?.[0].content.text).toBe('before//after');
  });

  it('throws RangeError when a required argument is missing', async () => {
    mockDbPrompts([
      {
        name: 'req-test',
        description: 'req',
        template: '{{must}}',
        argumentsSpec: [{ name: 'must', description: 'required', required: true }],
      },
    ]);
    await expect(getMcpPrompt('req-test', {})).rejects.toBeInstanceOf(RangeError);
  });

  it('throws RangeError when rendered output exceeds 64 KB', async () => {
    const giantValue = 'x'.repeat(70 * 1024); // > 64 KB
    mockDbPrompts([
      {
        name: 'huge-test',
        description: 'huge',
        template: '{{payload}}',
        argumentsSpec: [{ name: 'payload', description: 'payload', required: true }],
      },
    ]);
    await expect(getMcpPrompt('huge-test', { payload: giantValue })).rejects.toBeInstanceOf(
      RangeError
    );
  });

  it('caches the list and only hits the DB once within the TTL', async () => {
    mockDbPrompts([
      {
        name: 'cache-test',
        description: 'c',
        template: 't',
        argumentsSpec: [],
      },
    ]);
    await listMcpPrompts();
    await listMcpPrompts();
    await listMcpPrompts();
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it('clearMcpPromptCache forces a fresh DB read', async () => {
    mockDbPrompts([{ name: 'first', description: 'd', template: 't', argumentsSpec: [] }]);
    await listMcpPrompts();

    mockDbPrompts([{ name: 'second', description: 'd', template: 't', argumentsSpec: [] }]);
    clearMcpPromptCache();
    const prompts = await listMcpPrompts();
    expect(prompts.some((p) => p.name === 'second')).toBe(true);
  });

  it('tolerates malformed argumentsSpec (non-array) by normalising to empty', async () => {
    mockDbPrompts([
      {
        name: 'malformed',
        description: 'd',
        template: 'hello',
        argumentsSpec: 'not-an-array',
      },
    ]);
    const prompts = await listMcpPrompts();
    const m = prompts.find((p) => p.name === 'malformed');
    expect(m?.arguments).toEqual([]);
  });
});
