/**
 * Unit test: the finding-review request contract (F5.3, extended by F5.4).
 *
 * The interesting part is the reviewer's free-text steer. It is replayed verbatim into an LLM
 * prompt at batch apply, so it is bounded; and "cleared the box" has to land in the column as the
 * same thing as "never typed anything", or the two read differently everywhere downstream.
 */

import { describe, it, expect } from 'vitest';

import { MAX_APPLY_INSTRUCTION, reviewFindingSchema } from '@/lib/app/questionnaire/evaluation';

describe('reviewFindingSchema', () => {
  it('accepts a bare accept, leaving any steer typed earlier alone', () => {
    // `instruction` absent (not null) is the signal the route keys on: omitting the column from
    // the update is what stops accepting from silently discarding your own note.
    const parsed = reviewFindingSchema.parse({ action: 'accept' });
    expect(parsed).toEqual({ action: 'accept' });
    expect('instruction' in parsed).toBe(false);
  });

  it('carries a steer alongside an accept', () => {
    expect(
      reviewFindingSchema.parse({ action: 'accept', instruction: 'Keep it under 15 words.' })
    ).toEqual({ action: 'accept', instruction: 'Keep it under 15 words.' });
  });

  it('trims the steer, so trailing whitespace is not stored as content', () => {
    expect(
      reviewFindingSchema.parse({ action: 'set_instruction', instruction: '  Be terse.\n' })
    ).toEqual({ action: 'set_instruction', instruction: 'Be terse.' });
  });

  it('normalises an emptied box to null rather than an empty string', () => {
    // Two states that read differently — `''` is truthy-adjacent in enough places to matter, and
    // the batch engine branches on "did the reviewer say anything".
    for (const blank of ['', '   ', '\n\t']) {
      expect(reviewFindingSchema.parse({ action: 'set_instruction', instruction: blank })).toEqual({
        action: 'set_instruction',
        instruction: null,
      });
    }
  });

  it('lets a steer be cleared explicitly', () => {
    expect(reviewFindingSchema.parse({ action: 'set_instruction', instruction: null })).toEqual({
      action: 'set_instruction',
      instruction: null,
    });
  });

  it('requires an instruction on set_instruction — the action exists to write one', () => {
    expect(reviewFindingSchema.safeParse({ action: 'set_instruction' }).success).toBe(false);
  });

  it('bounds the steer, because it is replayed into a prompt', () => {
    const ok = 'x'.repeat(MAX_APPLY_INSTRUCTION);
    expect(
      reviewFindingSchema.safeParse({ action: 'set_instruction', instruction: ok }).success
    ).toBe(true);
    const tooLong = 'x'.repeat(MAX_APPLY_INSTRUCTION + 1);
    expect(
      reviewFindingSchema.safeParse({ action: 'set_instruction', instruction: tooLong }).success
    ).toBe(false);
  });

  it('still accepts the actions the UI no longer offers', () => {
    // `edit` is API-only now (the free-text steer replaced the typed op form), but existing rows
    // carry overrides and apply must keep honouring them.
    expect(
      reviewFindingSchema.safeParse({
        action: 'edit',
        editedOverride: { op: 'delete_question' },
      }).success
    ).toBe(true);
    expect(
      reviewFindingSchema.safeParse({ action: 'mark_applied', appliedToVersionId: 'v2' }).success
    ).toBe(true);
    expect(reviewFindingSchema.safeParse({ action: 'decline' }).success).toBe(true);
  });

  it('rejects an unknown action', () => {
    expect(reviewFindingSchema.safeParse({ action: 'apply' }).success).toBe(false);
  });
});
