/**
 * Unit tests: the agent / hybrid / deterministic node classification.
 *
 * The Behind-the-Scenes canvas splits steps three ways: a pure LLM `agent` step, a `hybrid` step
 * that runs a deterministic path AND an LLM path in the same turn (the safety gates), and plain
 * `deterministic` plumbing. These tests pin the pure classifier (`nodeExecutionKind`) and assert
 * the diagrams actually tag the safety gates as hybrid — so a gate that gains (or loses) its LLM
 * path can't silently revert to the misleading "Deterministic" or "AI agent" label.
 */

import { describe, expect, it } from 'vitest';

import {
  node,
  nodeExecutionKind,
  nodeExecutionKindFromMeta,
} from '@/lib/app/questionnaire/workflows/types';
import { WORKFLOW_DIAGRAMS } from '@/lib/app/questionnaire/workflows/registry';

/** Collect `diagramSlug/stepId` → execution kind for every step. */
function executionKinds(): Record<string, 'agent' | 'hybrid' | 'deterministic'> {
  const out: Record<string, 'agent' | 'hybrid' | 'deterministic'> = {};
  for (const d of WORKFLOW_DIAGRAMS) {
    for (const s of d.definition.steps) {
      out[`${d.slug}/${s.id}`] = nodeExecutionKind(s.config);
    }
  }
  return out;
}

describe('nodeExecutionKind', () => {
  it('classifies an agent-backed step as agent', () => {
    const step = node({
      id: 'x',
      name: 'x',
      type: 'agent_call',
      x: 0,
      y: 0,
      meta: { agentSlug: 'some-agent' },
    });
    expect(nodeExecutionKind(step.config)).toBe('agent');
  });

  it('classifies a prompt-only step (no agent row) as agent', () => {
    const step = node({
      id: 'x',
      name: 'x',
      type: 'guard',
      x: 0,
      y: 0,
      meta: { promptCatalogSlug: 'some-agent', promptSpecimenId: 'some.specimen' },
    });
    expect(nodeExecutionKind(step.config)).toBe('agent');
  });

  it('classifies a hybrid gate as hybrid even when it also carries a prompt', () => {
    const step = node({
      id: 'x',
      name: 'x',
      type: 'guard',
      x: 0,
      y: 0,
      meta: { hybrid: true, promptCatalogSlug: 'some-agent', promptSpecimenId: 'some.specimen' },
    });
    // hybrid wins over the agent signal — a hybrid gate is not a pure agent step.
    expect(nodeExecutionKind(step.config)).toBe('hybrid');
  });

  it('classifies plain plumbing as deterministic', () => {
    const step = node({ id: 'x', name: 'x', type: 'tool_call', x: 0, y: 0 });
    expect(nodeExecutionKind(step.config)).toBe('deterministic');
  });

  it('treats an absent config as deterministic', () => {
    expect(nodeExecutionKind(undefined)).toBe('deterministic');
    expect(nodeExecutionKindFromMeta({})).toBe('deterministic');
  });
});

describe('diagram execution tags', () => {
  const kinds = executionKinds();

  it('tags the safety gates as hybrid (deterministic floor + an LLM path)', () => {
    expect(kinds['conversation-turn/sensitivity']).toBe('hybrid');
    expect(kinds['conversation-turn/seriousness']).toBe('hybrid');
    // Data-slot mode runs the same gates in parity (before merge).
    expect(kinds['data-slot-turn/sensitivity']).toBe('hybrid');
    expect(kinds['data-slot-turn/seriousness']).toBe('hybrid');
  });

  it('tags the answer-fit validate gate as hybrid (type-validation floor + LLM force-fit)', () => {
    expect(kinds['answer-extraction/validate']).toBe('hybrid');
  });

  it('keeps pure LLM steps as agent', () => {
    expect(kinds['conversation-turn/extract']).toBe('agent');
    expect(kinds['conversation-turn/contradiction']).toBe('agent');
  });

  it('leaves deterministic plumbing as deterministic', () => {
    expect(kinds['conversation-turn/merge']).toBe('deterministic');
    expect(kinds['data-slot-turn/merge']).toBe('deterministic');
    // The park gate infers via the extraction call + a deterministic placeholder — not its own LLM path.
    expect(kinds['data-slot-turn/park']).toBe('deterministic');
  });
});
