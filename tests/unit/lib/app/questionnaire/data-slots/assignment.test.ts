/**
 * Unit test: the deterministic assign-orphans merge (`mergeAssignments`).
 *
 * The LLM only *decides* placement; this function does the writing. The tests pin the load-bearing
 * guarantees: existing slots are preserved verbatim and only gain keys, `new` placements become
 * (deduped) new slots, a `new` name that matches an existing slot folds in, and every orphan ends
 * up somewhere — a fallback slot when the model failed to place one.
 */

import { describe, it, expect } from 'vitest';

import {
  mergeAssignments,
  type AssignableSlot,
  type OrphanQuestion,
} from '@/lib/app/questionnaire/data-slots/assignment';
import type { DataSlotPlacement } from '@/lib/app/questionnaire/data-slots/schemas';

function existing(): AssignableSlot[] {
  return [
    {
      key: 'work_morale',
      name: 'Work morale',
      description: 'How the respondent feels about their work.',
      theme: 'Wellbeing',
      questionKeys: ['q_morale'],
    },
  ];
}

const orphan = (key: string, prompt = 'A new question?'): OrphanQuestion => ({ key, prompt });

describe('mergeAssignments', () => {
  it('adds an orphan to an existing slot, preserving the slot verbatim', () => {
    const placements: DataSlotPlacement[] = [
      { questionKey: 'q_team', target: { kind: 'existing', slotKey: 'work_morale' } },
    ];
    const result = mergeAssignments(existing(), placements, [orphan('q_team')]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'Work morale',
      description: 'How the respondent feels about their work.',
      theme: 'Wellbeing',
    });
    expect(result[0].questionKeys.sort()).toEqual(['q_morale', 'q_team']);
  });

  it('creates a new slot for a distinct data point', () => {
    const placements: DataSlotPlacement[] = [
      {
        questionKey: 'q_tenure',
        target: {
          kind: 'new',
          name: 'Tenure',
          description: 'How long they have worked here.',
          theme: 'Demographics',
        },
      },
    ];
    const result = mergeAssignments(existing(), placements, [orphan('q_tenure')]);

    expect(result).toHaveLength(2);
    const created = result.find((s) => s.name === 'Tenure');
    expect(created).toMatchObject({ theme: 'Demographics', questionKeys: ['q_tenure'] });
    // The existing slot is untouched.
    expect(result.find((s) => s.name === 'Work morale')?.questionKeys).toEqual(['q_morale']);
  });

  it('merges two orphans that propose the same new slot name into one slot', () => {
    const placements: DataSlotPlacement[] = [
      { questionKey: 'q_a', target: { kind: 'new', name: 'Tenure', description: 'd', theme: 'T' } },
      {
        questionKey: 'q_b',
        target: { kind: 'new', name: 'tenure', description: 'd2', theme: 'T' },
      },
    ];
    const result = mergeAssignments(existing(), placements, [orphan('q_a'), orphan('q_b')]);

    expect(result).toHaveLength(2);
    const created = result.find((s) => s.name === 'Tenure');
    expect(created?.questionKeys.sort()).toEqual(['q_a', 'q_b']);
  });

  it('folds a new placement whose name matches an existing slot into that slot', () => {
    const placements: DataSlotPlacement[] = [
      {
        questionKey: 'q_team',
        target: { kind: 'new', name: 'work morale', description: 'x', theme: 'y' },
      },
    ];
    const result = mergeAssignments(existing(), placements, [orphan('q_team')]);

    expect(result).toHaveLength(1); // no duplicate slot created
    expect(result[0].questionKeys.sort()).toEqual(['q_morale', 'q_team']);
  });

  it('humanizes a snake_case new-slot name the model returned', () => {
    const placements: DataSlotPlacement[] = [
      {
        questionKey: 'q_new',
        target: { kind: 'new', name: 'current_morale', description: 'd', theme: 'Wellbeing' },
      },
    ];
    const result = mergeAssignments(existing(), placements, [orphan('q_new')]);
    const created = result.find((s) => s.questionKeys.includes('q_new'));
    // Stored as a human name, matching the existing slots — not the snake_case key style.
    expect(created?.name).toBe('Current morale');
  });

  it('folds a snake_case new name into a matching human existing slot (underscore-insensitive)', () => {
    const slots: AssignableSlot[] = [
      {
        key: 'current_morale',
        name: 'Current morale',
        description: 'How the respondent feels.',
        theme: 'Wellbeing',
        questionKeys: ['q_a'],
      },
    ];
    const placements: DataSlotPlacement[] = [
      {
        questionKey: 'q_b',
        target: { kind: 'new', name: 'current_morale', description: 'x', theme: 'y' },
      },
    ];
    const result = mergeAssignments(slots, placements, [orphan('q_b')]);
    expect(result).toHaveLength(1); // folded — no duplicate
    expect(result[0].name).toBe('Current morale'); // existing name preserved verbatim
    expect(result[0].questionKeys.sort()).toEqual(['q_a', 'q_b']);
  });

  it('falls back to a prompt-derived slot when the model leaves an orphan unplaced', () => {
    const result = mergeAssignments(
      existing(),
      [], // model placed nothing
      [orphan('q_x', 'How long is your current tenure here?')]
    );
    expect(result).toHaveLength(2);
    const fallback = result.find((s) => s.questionKeys.includes('q_x'));
    expect(fallback).toBeTruthy();
    // Name is a short (≤4 word) slice of the prompt, not the whole sentence.
    expect(fallback!.name.split(/\s+/).length).toBeLessThanOrEqual(4);
  });

  it('treats an unknown existing slotKey as unplaced and falls back', () => {
    const placements: DataSlotPlacement[] = [
      { questionKey: 'q_x', target: { kind: 'existing', slotKey: 'does_not_exist' } },
    ];
    const result = mergeAssignments(existing(), placements, [orphan('q_x', 'Some question?')]);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.questionKeys.includes('q_x'))?.name).not.toBe('Work morale');
  });

  it('ignores placements for keys that are not in the orphan set', () => {
    const placements: DataSlotPlacement[] = [
      { questionKey: 'q_unrelated', target: { kind: 'existing', slotKey: 'work_morale' } },
    ];
    const result = mergeAssignments(existing(), placements, [orphan('q_real')]);
    // q_unrelated ignored; q_real falls back. Existing slot unchanged.
    expect(result.find((s) => s.name === 'Work morale')?.questionKeys).toEqual(['q_morale']);
    expect(result.some((s) => s.questionKeys.includes('q_real'))).toBe(true);
  });
});
