/**
 * Tests for `lib/orchestration/trace/render-conversation-markdown.ts`.
 *
 * The renderer is deterministic: same input produces byte-identical
 * output (modulo the footer timestamp). We verify the structure and
 * specific content rather than snapshotting the full string, because
 * snapshots make it too easy to silently accept formatting churn.
 */

import { describe, expect, it } from 'vitest';

import {
  renderConversationMarkdown,
  type RenderConversationInfo,
  type RenderConversationMessage,
} from '@/lib/orchestration/trace/render-conversation-markdown';

const baseConversation: RenderConversationInfo = {
  id: 'conv-1',
  title: 'Tenancy advice — deposit protection',
  userId: 'user-1',
  agentId: 'agent-1',
  agentSlug: 'tenant-rights-advisor',
  agentName: 'Tenant Rights Advisor',
  createdAt: '2026-05-18T08:00:00.000Z',
  updatedAt: '2026-05-18T08:05:00.000Z',
  isActive: true,
};

function makeMessage(overrides: Partial<RenderConversationMessage>): RenderConversationMessage {
  return {
    id: 'msg-x',
    role: 'user',
    content: 'placeholder',
    capabilitySlug: null,
    createdAt: '2026-05-18T08:00:00.000Z',
    agentVersionId: null,
    workflowExecutionId: null,
    workflowVersionId: null,
    modelId: null,
    providerSlug: null,
    provenance: null,
    ...overrides,
  };
}

describe('renderConversationMarkdown', () => {
  it('renders the conversation header with id, agent, and message count', () => {
    const md = renderConversationMarkdown(baseConversation, []);
    expect(md).toContain('# Conversation provenance — `conv-1`');
    expect(md).toContain('**Tenancy advice — deposit protection**');
    expect(md).toContain('| Agent | Tenant Rights Advisor (`tenant-rights-advisor`) |');
    expect(md).toContain('| User | `user-1` |');
    expect(md).toContain('| Messages | 0 |');
  });

  it('handles an empty message list with a clean placeholder', () => {
    const md = renderConversationMarkdown(baseConversation, []);
    expect(md).toContain('## Message timeline');
    expect(md).toContain('_No messages in this conversation._');
  });

  it('renders an assistant message with all four scalar pins', () => {
    const md = renderConversationMarkdown(baseConversation, [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        content: 'The deposit must be protected within 30 days.',
        modelId: 'claude-sonnet-4-6',
        providerSlug: 'anthropic',
        agentVersionId: 'av-1',
        workflowExecutionId: 'exec-1',
        workflowVersionId: 'wv-1',
      }),
    ]);
    expect(md).toContain('### 1. Assistant — 2026-05-18T08:00:00.000Z');
    expect(md).toContain('Model `claude-sonnet-4-6`');
    expect(md).toContain('Provider `anthropic`');
    expect(md).toContain('Agent version `av-1`');
    expect(md).toContain('Workflow execution `exec-1` @ `wv-1`');
  });

  it('renders citations with content hash, document name, and excerpt truncation', () => {
    const md = renderConversationMarkdown(baseConversation, [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        content: 'Deposit must be protected [1].',
        provenance: {
          citations: [
            {
              marker: 1,
              chunkId: 'chunk-1',
              documentId: 'doc-1',
              documentName: 'Tenancy Guide',
              contentHash: 'sha256-deadbeef0000000011112222',
              documentVersion: 3,
              section: 'Page 12',
              patternNumber: null,
              patternName: null,
              excerpt: 'Deposits must be protected within 30 days of receipt.',
              similarity: 0.91,
            },
          ],
        },
      }),
    ]);
    expect(md).toContain('**Citations (1)**');
    // contentHash is truncated to the first 16 chars + ellipsis for table compactness.
    expect(md).toContain('| [1] | Tenancy Guide (`doc-1`) | Page 12 | `sha256-deadbeef0…` |');
    expect(md).toContain('Deposits must be protected within 30 days');
  });

  it('renders capability call traces with success and latency', () => {
    const md = renderConversationMarkdown(baseConversation, [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        content: 'Looked it up.',
        provenance: {
          capabilityCalls: [
            {
              slug: 'lookup_order',
              arguments: { orderId: 'o_1' },
              latencyMs: 142,
              success: true,
              resultPreview: '{"id":"o_1"}',
            },
            {
              slug: 'send_email',
              arguments: { to: 'x' },
              latencyMs: 50,
              success: false,
              errorCode: 'forbidden',
            },
          ],
        },
      }),
    ]);
    expect(md).toContain('**Capability calls (2)**');
    expect(md).toContain('| `lookup_order` | `ok` | 142ms |');
    expect(md).toContain('| `send_email` | `fail: forbidden` | 50ms |');
  });

  it('renders workflow source provenance items when present', () => {
    const md = renderConversationMarkdown(baseConversation, [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        content: 'Workflow summary.',
        workflowExecutionId: 'exec-1',
        provenance: {
          workflowSources: [
            { source: 'knowledge_base', confidence: 'high', reference: 'doc-1', stepId: 'step-2' },
            { source: 'external_call', confidence: 'medium', reference: 'api-x' },
          ],
        },
      }),
    ]);
    expect(md).toContain('**Workflow sources (2)**');
    expect(md).toContain('| `step-2` | `knowledge_base` | `high` | doc-1 |');
    expect(md).toContain('| — | `external_call` | `medium` | api-x |');
  });

  it('includes the provenance summary when any trail has data', () => {
    const md = renderConversationMarkdown(baseConversation, [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        content: 'Answer with citation [1].',
        provenance: {
          citations: [
            {
              marker: 1,
              chunkId: 'c1',
              documentId: 'd1',
              documentName: 'Doc',
              contentHash: null,
              documentVersion: null,
              section: null,
              patternNumber: null,
              patternName: null,
              excerpt: 'x',
              similarity: 0.5,
            },
          ],
          capabilityCalls: [{ slug: 'x', arguments: {}, latencyMs: 1, success: true }],
        },
      }),
    ]);
    expect(md).toContain('## Provenance summary');
    expect(md).toContain('- **Citations:** 1');
    expect(md).toContain('- **Capability calls:** 1');
    expect(md).toContain('- **Workflow sources:** 0');
  });

  it('omits the provenance summary entirely when no message carries provenance', () => {
    const md = renderConversationMarkdown(baseConversation, [
      makeMessage({ id: 'msg-1', role: 'user', content: 'Hi.' }),
      makeMessage({ id: 'msg-2', role: 'assistant', content: 'Hello.' }),
    ]);
    expect(md).not.toContain('## Provenance summary');
  });

  it('escapes pipe characters in cell content so the table stays valid', () => {
    const md = renderConversationMarkdown(baseConversation, [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        content: 'See [1].',
        provenance: {
          citations: [
            {
              marker: 1,
              chunkId: 'c1',
              documentId: 'd1',
              documentName: 'Title with | pipe',
              contentHash: null,
              documentVersion: null,
              section: 'A | B',
              patternNumber: null,
              patternName: null,
              excerpt: 'has | pipe in body',
              similarity: 0.5,
            },
          ],
        },
      }),
    ]);
    // The cell content escapes the bare pipe to `\|` so the table parser
    // doesn't split the column on the wrong character.
    expect(md).toContain('Title with \\| pipe');
    expect(md).toContain('A \\| B');
    expect(md).toContain('has \\| pipe in body');
  });

  it('escapes backslashes so a trailing `\\` cannot escape the pipe delimiter', () => {
    const md = renderConversationMarkdown(baseConversation, [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        content: 'See [1].',
        provenance: {
          citations: [
            {
              marker: 1,
              chunkId: 'c1',
              documentId: 'd1',
              documentName: 'path\\',
              contentHash: null,
              documentVersion: null,
              section: 'a\\|b',
              patternNumber: null,
              patternName: null,
              excerpt: 'ends with slash\\',
              similarity: 0.5,
            },
          ],
        },
      }),
    ]);
    // `path\` becomes `path\\` (literal backslash, not an escape of the next `|`).
    expect(md).toContain('path\\\\');
    expect(md).toContain('ends with slash\\\\');
    // `a\|b` → backslash doubled first, then the bare pipe escaped → `a\\\|b`.
    expect(md).toContain('a\\\\\\|b');
  });

  it('produces deterministic output for the same input (ignoring footer timestamp)', () => {
    const fixture: RenderConversationMessage[] = [
      makeMessage({
        id: 'msg-1',
        role: 'user',
        content: 'Ask',
        createdAt: '2026-05-18T08:00:00.000Z',
      }),
      makeMessage({
        id: 'msg-2',
        role: 'assistant',
        content: 'Reply [1].',
        modelId: 'claude-sonnet-4-6',
        providerSlug: 'anthropic',
        createdAt: '2026-05-18T08:00:05.000Z',
        provenance: {
          citations: [
            {
              marker: 1,
              chunkId: 'c1',
              documentId: 'd1',
              documentName: 'Doc',
              contentHash: 'sha256-x',
              documentVersion: 1,
              section: null,
              patternNumber: null,
              patternName: null,
              excerpt: 'x',
              similarity: 0.9,
            },
          ],
        },
      }),
    ];
    const first = renderConversationMarkdown(baseConversation, fixture);
    const second = renderConversationMarkdown(baseConversation, fixture);
    // Strip the footer "Generated …" line which contains a wall-clock
    // timestamp, then compare the rest byte-for-byte.
    const strip = (s: string) => s.replace(/Generated [^\n]+/, 'Generated <ts>');
    expect(strip(first)).toBe(strip(second));
  });

  it('uses relative URL by default and absolutizes with hostPrefix option', () => {
    const relative = renderConversationMarkdown(baseConversation, []);
    expect(relative).toContain('[open in admin](/admin/orchestration/conversations/conv-1)');

    const absolute = renderConversationMarkdown(baseConversation, [], {
      hostPrefix: 'https://admin.example.com',
    });
    expect(absolute).toContain(
      '[open in admin](https://admin.example.com/admin/orchestration/conversations/conv-1)'
    );
  });

  // ── Branch coverage: defensive fallbacks ───────────────────────────────────

  describe('rendering edge cases', () => {
    it('renders an unknown message role verbatim (roleLabel default case)', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({ id: 'm-1', role: 'observer', content: 'noted' }),
      ]);
      // The default arm of `roleLabel` returns the role unchanged.
      expect(md).toContain('### 1. observer — ');
    });

    it('renders an _empty content_ placeholder when an assistant message has no body', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({ id: 'm-1', role: 'assistant', content: '   ' }),
      ]);
      expect(md).toContain('_empty content_');
    });

    it('fence-renders tool messages with truncation', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({
          id: 'm-tool',
          role: 'tool',
          content: '{"data":"some long tool result"}',
          capabilitySlug: 'lookup_order',
        }),
      ]);
      expect(md).toContain('Capability `lookup_order`');
      // Code fence applied.
      expect(md).toMatch(/```\n\{"data":"some long tool result"\}\n```/);
    });

    it('falls back to "(untitled conversation)" when title is null', () => {
      const md = renderConversationMarkdown({ ...baseConversation, title: null }, []);
      expect(md).toContain('(untitled conversation)');
    });

    it('renders citations with no documentName / contentHash / section as dashes', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({
          id: 'm-1',
          role: 'assistant',
          content: 'A [1].',
          provenance: {
            citations: [
              {
                marker: 1,
                chunkId: 'c1',
                documentId: 'd1',
                documentName: null,
                contentHash: null,
                documentVersion: null,
                section: null,
                patternNumber: null,
                patternName: null,
                excerpt: 'x',
                similarity: 0.5,
              },
            ],
          },
        }),
      ]);
      // The doc-label uses just the documentId in backticks when name is null.
      expect(md).toContain('| [1] | `d1` | — | — |');
    });

    it('renders capability calls without resultPreview / costUsd as dashes', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({
          id: 'm-1',
          role: 'assistant',
          content: 'Done.',
          provenance: {
            capabilityCalls: [
              {
                slug: 'no_preview',
                arguments: {},
                latencyMs: 7,
                success: true,
              },
            ],
          },
        }),
      ]);
      // Both resultPreview and cost fall back to '—'.
      expect(md).toContain('| `no_preview` | `ok` | 7ms | — | — |');
    });

    it('renders workflow source items without stepId / reference / note as dashes', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({
          id: 'm-1',
          role: 'assistant',
          content: 'Wf.',
          provenance: {
            workflowSources: [{ source: 'training_knowledge', confidence: 'low' }],
          },
        }),
      ]);
      // All optional fields fall back to '—'.
      expect(md).toContain('| — | `training_knowledge` | `low` | — | — |');
    });

    it('renders the workflow-execution pin without a version when workflowVersionId is null', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({
          id: 'm-1',
          role: 'assistant',
          content: 'Hi.',
          workflowExecutionId: 'exec-1',
          workflowVersionId: null,
        }),
      ]);
      // No `@ <version>` suffix when null.
      expect(md).toContain('Workflow execution `exec-1`');
      expect(md).not.toContain('@');
    });

    it('falls back to agentSlug then agentId then "—" when agentName is null', () => {
      // agentName null, agentSlug present → uses slug.
      const m1 = renderConversationMarkdown(
        { ...baseConversation, agentName: null, agentSlug: 'tenant-advisor' },
        []
      );
      expect(m1).toContain('| Agent | `tenant-advisor` |');

      // agentName + agentSlug both null, agentId present → uses agentId.
      const m2 = renderConversationMarkdown(
        { ...baseConversation, agentName: null, agentSlug: null, agentId: 'agent-1' },
        []
      );
      expect(m2).toContain('| Agent | `agent-1` |');

      // All three null → '—'
      const m3 = renderConversationMarkdown(
        { ...baseConversation, agentName: null, agentSlug: null, agentId: null },
        []
      );
      expect(m3).toContain('| Agent | `—` |');
    });

    it('truncates an excerpt that exceeds the cap', () => {
      const longExcerpt = 'x'.repeat(2000);
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({
          id: 'm-1',
          role: 'assistant',
          content: 'A.',
          provenance: {
            citations: [
              {
                marker: 1,
                chunkId: 'c1',
                documentId: 'd1',
                documentName: 'Doc',
                contentHash: null,
                documentVersion: null,
                section: null,
                patternNumber: null,
                patternName: null,
                excerpt: longExcerpt,
                similarity: 0.5,
              },
            ],
          },
        }),
        // also truncate the workflow-source long reference and note
        makeMessage({
          id: 'm-2',
          role: 'assistant',
          content: 'B.',
          provenance: {
            workflowSources: [
              {
                source: 'web_search',
                confidence: 'medium',
                reference: 'r'.repeat(200),
                note: 'n'.repeat(200),
              },
            ],
          },
        }),
      ]);
      expect(md).toContain('…');
    });

    it('renders a capability fail envelope with the errorCode', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({
          id: 'm-1',
          role: 'assistant',
          content: 'Tried.',
          provenance: {
            capabilityCalls: [
              {
                slug: 'send_email',
                arguments: {},
                latencyMs: 50,
                success: false,
                errorCode: 'forbidden',
                costUsd: 0.001,
              },
            ],
          },
        }),
      ]);
      expect(md).toContain('| `send_email` | `fail: forbidden` | 50ms | $0.0010 |');
    });

    it('uses the "unknown" errorCode placeholder on a fail envelope with no errorCode', () => {
      const md = renderConversationMarkdown(baseConversation, [
        makeMessage({
          id: 'm-1',
          role: 'assistant',
          content: 'Tried.',
          provenance: {
            capabilityCalls: [
              {
                slug: 'send_email',
                arguments: {},
                latencyMs: 50,
                success: false,
              },
            ],
          },
        }),
      ]);
      expect(md).toContain('`fail: unknown`');
    });
  });
});
