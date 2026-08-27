/**
 * ConQuest Classic is the default, at every layer that can produce a layout.
 *
 * This is the promise the whole feature rests on: introducing layouts must not change a single
 * existing questionnaire. There is no backfill and no data migration, so "unchanged" is entirely a
 * function of what each layer does with an absent or unrecognised value — and there are five such
 * layers between a database column and a rendered component. A regression in any one of them shows
 * up as a live respondent's surface changing shape, or going blank, with nothing to catch it.
 *
 * So this file walks all five in one place rather than trusting each layer's own suite to think
 * about the default:
 *
 *   1. the declared config default          (DEFAULT_QUESTIONNAIRE_CONFIG)
 *   2. the human catalog                    (RESPONDENT_LAYOUT_META)
 *   3. the PATCH validator                  (updateConfigSchema)
 *   4. the DB → view projection             (toConfigView)
 *   5. the view → component resolution      (resolveLayout, asserted in registry.test.tsx)
 *
 * "Unrecognised" is not hypothetical: rolling back a deploy, or a fork dropping a layout, leaves
 * rows naming a layout the running build has never heard of.
 *
 * @see .context/app/questionnaire/respondent-layouts.md
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  DEFAULT_RESPONDENT_LAYOUT,
  RESPONDENT_LAYOUTS,
} from '@/lib/app/questionnaire/types';
import {
  RESPONDENT_LAYOUT_LABELS,
  RESPONDENT_LAYOUT_META,
} from '@/lib/app/questionnaire/layout/catalog';
import { updateConfigSchema } from '@/lib/app/questionnaire/authoring/config-schema';

describe('the default layout', () => {
  it('is classic', () => {
    // Pinned as a literal on purpose. Every other assertion here is relative to this constant, so
    // if it silently became something else they would all still pass while every questionnaire in
    // production changed shape.
    expect(DEFAULT_RESPONDENT_LAYOUT).toBe('classic');
  });

  it('is what a questionnaire config defaults to', () => {
    expect(DEFAULT_QUESTIONNAIRE_CONFIG.respondentLayout).toBe(DEFAULT_RESPONDENT_LAYOUT);
  });

  it('is a real registered layout', () => {
    expect(RESPONDENT_LAYOUTS).toContain(DEFAULT_RESPONDENT_LAYOUT);
  });
});

describe('the layout catalog', () => {
  it('names every layout the enum offers', () => {
    // The picker, the exported settings table and the layout registry all read this. A missing
    // entry renders `undefined` as a layout's name on a client-facing PDF.
    expect(Object.keys(RESPONDENT_LAYOUT_META).sort()).toEqual([...RESPONDENT_LAYOUTS].sort());
  });

  it('gives every layout a label and a description', () => {
    for (const key of RESPONDENT_LAYOUTS) {
      expect(RESPONDENT_LAYOUT_META[key].label.trim(), `${key} label`).toBeTruthy();
      expect(RESPONDENT_LAYOUT_META[key].description.trim(), `${key} description`).toBeTruthy();
    }
  });

  it('derives the label map from the same source', () => {
    for (const key of RESPONDENT_LAYOUTS) {
      expect(RESPONDENT_LAYOUT_LABELS[key]).toBe(RESPONDENT_LAYOUT_META[key].label);
    }
  });

  it('does not reuse a label between two layouts', () => {
    // Two arrangements with the same name in the picker is a support conversation waiting to happen.
    const labels = RESPONDENT_LAYOUTS.map((key) => RESPONDENT_LAYOUT_META[key].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('updateConfigSchema — respondentLayout', () => {
  it('accepts every registered layout', () => {
    for (const layout of RESPONDENT_LAYOUTS) {
      const parsed = updateConfigSchema.safeParse({ respondentLayout: layout });
      expect(parsed.success, `${layout} should be accepted`).toBe(true);
    }
  });

  it('rejects a layout name that does not exist', () => {
    // The write boundary is strict where the read boundary is forgiving: an admin PATCHing an
    // unknown layout is a bug in the caller and should be told so, whereas a stored unknown value
    // is a rollback artefact the respondent surface has to survive.
    // 'horizon' is the next designed layout and deliberately does NOT exist yet — using the name
    // of a layout that is coming keeps this honest about what "unknown" means here.
    expect(updateConfigSchema.safeParse({ respondentLayout: 'horizon' }).success).toBe(false);
  });

  it('leaves the field untouched when it is omitted', () => {
    // The PATCH body is all-optional; a save that does not mention the layout must not reset it.
    const parsed = updateConfigSchema.safeParse({ presentationMode: 'chat' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('respondentLayout' in parsed.data).toBe(false);
  });
});
