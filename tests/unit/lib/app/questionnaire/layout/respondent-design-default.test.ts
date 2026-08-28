/**
 * ConQuest Rounded is the default, at every layer that can produce a design.
 *
 * The same promise the layout axis rests on, made again for the third axis and worth making
 * separately rather than trusting the shape of the first: introducing designs must not change a
 * single existing questionnaire. There is no backfill, so "unchanged" is entirely a function of
 * what each layer does with an absent or unrecognised value.
 *
 * The design axis fails DIFFERENTLY from the layout axis, though, and that is why this file exists
 * rather than a few extra cases in its sibling. An unknown LAYOUT is resolved through a registry
 * lookup that a component can notice and fall back from. An unknown DESIGN becomes a `data-design`
 * attribute that matches no block in `app/respondent-design.css` — no error, no fallback, just a
 * questionnaire quietly wearing the platform's own corners. There is nothing downstream to catch
 * it, so every layer that can produce one has to narrow, and every one of them is checked here:
 *
 *   1. the declared config default          (DEFAULT_QUESTIONNAIRE_CONFIG)
 *   2. the human catalog                    (RESPONDENT_DESIGN_META)
 *   3. the PATCH validator                  (updateConfigSchema)
 *   4. the component default                (BrandThemeProvider, asserted in its own suite)
 *   5. the stylesheet's own coverage        (respondent-design-css.test.ts)
 *
 * @see .context/app/questionnaire/respondent-designs.md
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  DEFAULT_RESPONDENT_DESIGN,
  RESPONDENT_DESIGNS,
} from '@/lib/app/questionnaire/types';
import {
  RESPONDENT_DESIGN_LABELS,
  RESPONDENT_DESIGN_META,
} from '@/lib/app/questionnaire/layout/catalog';
import { updateConfigSchema } from '@/lib/app/questionnaire/authoring/config-schema';

describe('the default design', () => {
  it('is rounded', () => {
    // Pinned as a literal on purpose. Every other assertion here is relative to this constant, so
    // if it silently became something else they would all still pass while every questionnaire in
    // production changed appearance.
    expect(DEFAULT_RESPONDENT_DESIGN).toBe('rounded');
  });

  it('is what a questionnaire config defaults to', () => {
    expect(DEFAULT_QUESTIONNAIRE_CONFIG.respondentDesign).toBe(DEFAULT_RESPONDENT_DESIGN);
  });

  it('is a real registered design', () => {
    expect(RESPONDENT_DESIGNS).toContain(DEFAULT_RESPONDENT_DESIGN);
  });
});

describe('the design catalog', () => {
  it('names every design the enum offers', () => {
    // The picker and the exported settings table both read this. A missing entry renders
    // `undefined` as a design's name on a client-facing PDF.
    expect(Object.keys(RESPONDENT_DESIGN_META).sort()).toEqual([...RESPONDENT_DESIGNS].sort());
  });

  it('gives every design a label and a description', () => {
    for (const key of RESPONDENT_DESIGNS) {
      expect(RESPONDENT_DESIGN_META[key].label.trim(), `${key} label`).toBeTruthy();
      expect(RESPONDENT_DESIGN_META[key].description.trim(), `${key} description`).toBeTruthy();
    }
  });

  it('derives the label map from the same source', () => {
    for (const key of RESPONDENT_DESIGNS) {
      expect(RESPONDENT_DESIGN_LABELS[key]).toBe(RESPONDENT_DESIGN_META[key].label);
    }
  });

  it('does not reuse a label between two designs, or with a layout', () => {
    // Two designs sharing a name is a support conversation; a design sharing a name with a LAYOUT
    // is worse, because the two settings sit one above the other on the same tab and an admin
    // reading "Broadsheet" in both would reasonably assume they were connected.
    const labels = RESPONDENT_DESIGNS.map((key) => RESPONDENT_DESIGN_META[key].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('updateConfigSchema — respondentDesign', () => {
  it('accepts every registered design', () => {
    for (const design of RESPONDENT_DESIGNS) {
      const parsed = updateConfigSchema.safeParse({ respondentDesign: design });
      expect(parsed.success, `${design} should be accepted`).toBe(true);
    }
  });

  it('rejects a design name that does not exist', () => {
    // Strict at the write boundary, forgiving at the read boundary — the same asymmetry the other
    // two axes use. An admin PATCHing an unknown design is a caller bug and should be told; a
    // stored unknown value is a rollback artefact a live respondent has to survive.
    expect(updateConfigSchema.safeParse({ respondentDesign: 'brutal' }).success).toBe(false);
  });

  it('does not accept a LAYOUT name in the design field', () => {
    // The two settings sit adjacent on the tab and their values are both lowercase single words.
    // Crossing them in a PATCH payload is the plausible caller bug, and it has to be rejected
    // rather than stored — a `data-design="broadsheet"` attribute matches no stylesheet block.
    expect(updateConfigSchema.safeParse({ respondentDesign: 'broadsheet' }).success).toBe(false);
  });

  it('leaves the field untouched when it is omitted', () => {
    // The PATCH body is all-optional; a save that does not mention the design must not reset it.
    const parsed = updateConfigSchema.safeParse({ presentationMode: 'chat' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('respondentDesign' in parsed.data).toBe(false);
  });
});
