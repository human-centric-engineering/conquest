/**
 * Unit tests: the retrieval/vector node highlight.
 *
 * The Behind-the-Scenes canvas gives a distinct third node treatment to steps that read a
 * knowledge base (`_meta.kb`) or run an embedding/vector engine (`_meta.vector`). These tests pin
 * the pure classifier (`nodeRetrievalKind`) and assert the diagrams actually tag the steps that
 * touch KB or vectors — so a step that starts (or stops) using retrieval can't silently lose its
 * highlight.
 */

import { describe, expect, it } from 'vitest';

import { node, nodeRetrievalKind } from '@/lib/app/questionnaire/workflows/types';
import { WORKFLOW_DIAGRAMS } from '@/lib/app/questionnaire/workflows/registry';

/** Collect `diagramSlug/stepId` → retrieval kind for every retrieval-tagged step. */
function retrievalNodes(): Record<string, 'kb' | 'vector'> {
  const out: Record<string, 'kb' | 'vector'> = {};
  for (const d of WORKFLOW_DIAGRAMS) {
    for (const s of d.definition.steps) {
      const kind = nodeRetrievalKind(s.config);
      if (kind) out[`${d.slug}/${s.id}`] = kind;
    }
  }
  return out;
}

describe('nodeRetrievalKind', () => {
  it('classifies a kb step as kb', () => {
    const step = node({
      id: 'x',
      name: 'x',
      type: 'rag_retrieve',
      x: 0,
      y: 0,
      meta: { kb: { status: 'active', mechanism: 'demo-client-tag', description: '' } },
    });
    expect(nodeRetrievalKind(step.config)).toBe('kb');
  });

  it('classifies a vector step as vector', () => {
    const step = node({
      id: 'x',
      name: 'x',
      type: 'agent_call',
      x: 0,
      y: 0,
      meta: { vector: { status: 'active', description: '' } },
    });
    expect(nodeRetrievalKind(step.config)).toBe('vector');
  });

  it('returns null for a plain step', () => {
    const step = node({ id: 'x', name: 'x', type: 'tool_call', x: 0, y: 0 });
    expect(nodeRetrievalKind(step.config)).toBeNull();
  });

  it('prefers kb when a step carries both', () => {
    const step = node({
      id: 'x',
      name: 'x',
      type: 'agent_call',
      x: 0,
      y: 0,
      meta: {
        kb: { status: 'active', mechanism: 'agent-grant', description: '' },
        vector: { status: 'active', description: '' },
      },
    });
    expect(nodeRetrievalKind(step.config)).toBe('kb');
  });
});

describe('diagram retrieval tags', () => {
  const nodes = retrievalNodes();

  it('tags the KB-reading report/ingestion steps as kb', () => {
    expect(nodes['respondent-report/knowledge']).toBe('kb');
    expect(nodes['cohort-report/context']).toBe('kb');
    expect(nodes['document-ingestion/extract']).toBe('kb');
  });

  it('tags the embedding-ranked selection + extraction steps as vector', () => {
    expect(nodes['conversation-turn/select']).toBe('vector');
    expect(nodes['conversation-turn/extract']).toBe('vector');
    expect(nodes['answer-extraction/extract']).toBe('vector');
    expect(nodes['data-slot-turn/nextslot']).toBe('vector');
    expect(nodes['data-slot-turn/extract']).toBe('vector');
  });

  it('tags the inspector vector-capture step as vector', () => {
    expect(nodes['turn-inspector/embed']).toBe('vector');
  });

  it('leaves deterministic plumbing untagged', () => {
    expect(nodes['conversation-turn/merge']).toBeUndefined();
    expect(nodes['turn-evaluation/persist']).toBeUndefined();
  });
});
