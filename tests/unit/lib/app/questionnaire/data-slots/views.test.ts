/**
 * Data-slots view contracts — unit tests
 *
 * The views module is intentionally type-only (interfaces, no runtime code).
 * These tests verify the structural contracts by constructing conforming
 * objects and asserting their shapes — giving TypeScript a chance to reject
 * mismatched assignments at compile time while giving Vitest a runtime
 * record that the contracts are exercised.
 *
 * What is tested:
 * - GeneratedDataSlot: all required fields present and correctly typed
 * - DataSlotView: all required fields including ordinal/weight/key
 * - DataSlotQuestionRef: minimal two-field contract
 * - DataSlotDraftView: slots array + ISO-8601 updatedAt
 * - Structural compatibility: a GeneratedDataSlot is assignable as the
 *   slots member of a DataSlotDraftView (the interface relationship)
 *
 * NOTE: views.ts exports no runtime values — every export is an interface.
 * Coverage tools report 0% lines/statements/branches/functions for this
 * file because there are zero executable statements to instrument. The
 * TypeScript compiler is the authoritative "test" for this module; these
 * Vitest specs provide a runtime record of the contracts and will surface
 * any accidental breakage if the interfaces ever acquire computed defaults
 * or helper functions.
 *
 * @see lib/app/questionnaire/data-slots/views.ts
 */

import { describe, it, expect } from 'vitest';

import type {
  GeneratedDataSlot,
  DataSlotView,
  DataSlotQuestionRef,
  DataSlotDraftView,
} from '@/lib/app/questionnaire/data-slots/views';

// ---------------------------------------------------------------------------
// GeneratedDataSlot
// ---------------------------------------------------------------------------

describe('GeneratedDataSlot contract', () => {
  it('accepts an object with all required fields', () => {
    const slot: GeneratedDataSlot = {
      name: 'Onboarding ease',
      description: 'How straightforward the initial setup feels for new users.',
      theme: 'Onboarding',
      questionKeys: ['q1', 'q2'],
      confidence: 0.85,
    };

    expect(slot.name).toBe('Onboarding ease');
    expect(slot.description).toContain('straightforward');
    expect(slot.theme).toBe('Onboarding');
    expect(slot.questionKeys).toEqual(['q1', 'q2']);
    expect(slot.confidence).toBe(0.85);
  });

  it('accepts an empty questionKeys array (no mapped questions yet)', () => {
    const slot: GeneratedDataSlot = {
      name: 'Time to value',
      description: 'Speed at which users reach their first meaningful outcome.',
      theme: 'Value',
      questionKeys: [],
      confidence: 0.5,
    };

    expect(slot.questionKeys).toHaveLength(0);
  });

  it('accepts confidence at the 0 boundary', () => {
    const slot: GeneratedDataSlot = {
      name: 'Low confidence slot',
      description: 'Uncertain semantic target.',
      theme: 'Misc',
      questionKeys: ['q1'],
      confidence: 0,
    };

    expect(slot.confidence).toBe(0);
  });

  it('accepts confidence at the 1 boundary', () => {
    const slot: GeneratedDataSlot = {
      name: 'High confidence',
      description: 'Very clear semantic target.',
      theme: 'Core',
      questionKeys: ['q1'],
      confidence: 1,
    };

    expect(slot.confidence).toBe(1);
  });

  it('supports multiple questionKeys (one slot abstracts over several questions)', () => {
    const slot: GeneratedDataSlot = {
      name: 'Support quality',
      description: 'Covers responsiveness, empathy, and resolution speed.',
      theme: 'Support',
      questionKeys: ['q3', 'q4', 'q5'],
      confidence: 0.75,
    };

    expect(slot.questionKeys).toHaveLength(3);
    expect(slot.questionKeys).toContain('q4');
  });
});

// ---------------------------------------------------------------------------
// DataSlotView
// ---------------------------------------------------------------------------

describe('DataSlotView contract', () => {
  it('accepts a fully-populated persisted slot', () => {
    const view: DataSlotView = {
      id: 'clxabc123',
      key: 'onboarding-ease',
      name: 'Onboarding ease',
      description: 'How straightforward the initial setup feels.',
      theme: 'Onboarding',
      ordinal: 1,
      weight: 1.0,
      questionKeys: ['q1', 'q2'],
    };

    expect(view.id).toBe('clxabc123');
    expect(view.key).toBe('onboarding-ease');
    expect(view.ordinal).toBe(1);
    expect(view.weight).toBe(1.0);
    expect(view.questionKeys).toEqual(['q1', 'q2']);
  });

  it('supports ordinal=0 (first position)', () => {
    const view: DataSlotView = {
      id: 'id1',
      key: 'first-slot',
      name: 'First slot',
      description: 'The first slot in the version.',
      theme: 'General',
      ordinal: 0,
      weight: 1,
      questionKeys: [],
    };

    expect(view.ordinal).toBe(0);
  });

  it('supports an empty questionKeys array on a persisted slot', () => {
    const view: DataSlotView = {
      id: 'id2',
      key: 'unmapped-slot',
      name: 'Unmapped',
      description: 'Not yet mapped to questions.',
      theme: 'Misc',
      ordinal: 2,
      weight: 1,
      questionKeys: [],
    };

    expect(view.questionKeys).toHaveLength(0);
  });

  it('key field is distinct from id (slug vs opaque id)', () => {
    const view: DataSlotView = {
      id: 'opaque-cuid',
      key: 'human-readable-slug',
      name: 'A slot',
      description: 'desc',
      theme: 'T',
      ordinal: 1,
      weight: 1,
      questionKeys: [],
    };

    expect(view.id).not.toBe(view.key);
  });
});

// ---------------------------------------------------------------------------
// DataSlotQuestionRef
// ---------------------------------------------------------------------------

describe('DataSlotQuestionRef contract', () => {
  it('accepts the minimal two-field contract', () => {
    const ref: DataSlotQuestionRef = {
      key: 'q1',
      prompt: 'How easy was onboarding?',
    };

    expect(ref.key).toBe('q1');
    expect(ref.prompt).toBe('How easy was onboarding?');
  });

  it('accepts a reference with a multi-word prompt', () => {
    const ref: DataSlotQuestionRef = {
      key: 'q42',
      prompt: 'On a scale of 1–10, how likely are you to recommend us to a colleague?',
    };

    expect(ref.key).toBe('q42');
    expect(ref.prompt).toContain('recommend');
  });
});

// ---------------------------------------------------------------------------
// DataSlotDraftView
// ---------------------------------------------------------------------------

describe('DataSlotDraftView contract', () => {
  it('accepts a draft with a non-empty slots array and ISO-8601 updatedAt', () => {
    const draft: DataSlotDraftView = {
      slots: [
        {
          name: 'Onboarding ease',
          description: 'How straightforward the initial setup feels.',
          theme: 'Onboarding',
          questionKeys: ['q1'],
          confidence: 0.9,
        },
      ],
      updatedAt: '2024-06-01T12:00:00.000Z',
    };

    expect(draft.slots).toHaveLength(1);
    expect(draft.updatedAt).toBe('2024-06-01T12:00:00.000Z');
  });

  it('accepts an empty slots array (proposal cleared)', () => {
    const draft: DataSlotDraftView = {
      slots: [],
      updatedAt: new Date().toISOString(),
    };

    expect(draft.slots).toHaveLength(0);
    // updatedAt is a valid ISO-8601 string
    expect(new Date(draft.updatedAt).getTime()).not.toBeNaN();
  });

  it('accepts multiple slots in the draft', () => {
    const makeSlot = (name: string): GeneratedDataSlot => ({
      name,
      description: `Description for ${name}`,
      theme: 'General',
      questionKeys: [],
      confidence: 0.5,
    });

    const draft: DataSlotDraftView = {
      slots: [makeSlot('Slot A'), makeSlot('Slot B'), makeSlot('Slot C')],
      updatedAt: '2024-06-15T09:30:00.000Z',
    };

    expect(draft.slots).toHaveLength(3);
    expect(draft.slots.map((s) => s.name)).toEqual(['Slot A', 'Slot B', 'Slot C']);
  });

  it('draft slots are GeneratedDataSlot objects (structural compatibility)', () => {
    // Verifies that GeneratedDataSlot satisfies the DataSlotDraftView.slots element type.
    const generatedSlot: GeneratedDataSlot = {
      name: 'Structural fit',
      description: 'Tests that GeneratedDataSlot is assignable as slots element.',
      theme: 'Meta',
      questionKeys: ['q99'],
      confidence: 0.7,
    };

    const draft: DataSlotDraftView = {
      slots: [generatedSlot],
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    // The GeneratedDataSlot fields are accessible through the draft's slots array.
    expect(draft.slots[0].name).toBe('Structural fit');
    expect(draft.slots[0].confidence).toBe(0.7);
    expect(draft.slots[0].questionKeys).toContain('q99');
  });
});
