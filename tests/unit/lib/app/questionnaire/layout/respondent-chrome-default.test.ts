/**
 * The chrome default, walked end to end.
 *
 * `respondentChrome` has no backfill. Every questionnaire that predates the column keeps its header
 * and footer purely because four separate layers all resolve an absent or unrecognised value to
 * `full`, and a regression in any one of them strips a live respondent's page of its chrome — or,
 * worse, silently white-labels a questionnaire whose client never asked for that.
 *
 * The asymmetry is deliberate and is asserted here too: the WRITE boundary rejects an unknown
 * value, because an admin PATCHing one is a caller bug worth surfacing, while every READ boundary
 * accepts it and falls back, because a stored unknown value is a rollback artefact a live
 * respondent has to survive.
 *
 * @see lib/app/questionnaire/types.ts
 * @see .context/app/questionnaire/respondent-chrome.md
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  DEFAULT_RESPONDENT_CHROME,
  RESPONDENT_CHROMES,
  narrowToEnum,
} from '@/lib/app/questionnaire/types';
import {
  RESPONDENT_CHROME_LABELS,
  RESPONDENT_CHROME_META,
} from '@/lib/app/questionnaire/layout/catalog';
import { updateConfigSchema } from '@/lib/app/questionnaire/authoring/config-schema';

describe('the chrome default', () => {
  it('is full — the chrome every respondent page has always had', () => {
    expect(DEFAULT_RESPONDENT_CHROME).toBe('full');
    expect(DEFAULT_QUESTIONNAIRE_CONFIG.respondentChrome).toBe('full');
  });

  it('resolves an absent value to full', () => {
    // A version saved before the column existed — or one with no config row at all — reads as
    // `undefined`. Written the way the resolver writes it (`?? DEFAULT` ahead of the narrowing),
    // because that pairing IS the read path: `narrowToEnum` never sees the undefined itself.
    const stored: string | undefined = undefined;
    expect(
      narrowToEnum(
        stored ?? DEFAULT_RESPONDENT_CHROME,
        RESPONDENT_CHROMES,
        DEFAULT_RESPONDENT_CHROME
      )
    ).toBe('full');
  });

  it('resolves a value this build does not know to full', () => {
    // The rollback case. A build that shipped a fourth mode, then rolled back, leaves rows naming
    // it — and a respondent mid-questionnaire must not find the page around them gone.
    expect(narrowToEnum('kiosk_mode', RESPONDENT_CHROMES, DEFAULT_RESPONDENT_CHROME)).toBe('full');
  });
});

describe('the chrome catalog', () => {
  it('gives every mode a label and a description', () => {
    for (const key of RESPONDENT_CHROMES) {
      expect(RESPONDENT_CHROME_META[key].label.trim(), `${key} label`).toBeTruthy();
      expect(RESPONDENT_CHROME_META[key].description.trim(), `${key} description`).toBeTruthy();
    }
  });

  it('derives the label map from the same source', () => {
    // The settings tab, the exported settings table and the registry all read one source; two
    // copies is how a client-facing PDF ends up disagreeing with the screen it was configured on.
    for (const key of RESPONDENT_CHROMES) {
      expect(RESPONDENT_CHROME_LABELS[key]).toBe(RESPONDENT_CHROME_META[key].label);
    }
  });

  it('does not reuse a label between two modes', () => {
    const labels = RESPONDENT_CHROMES.map((key) => RESPONDENT_CHROME_META[key].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('updateConfigSchema — respondentChrome', () => {
  it('accepts every registered mode', () => {
    for (const chrome of RESPONDENT_CHROMES) {
      const parsed = updateConfigSchema.safeParse({ respondentChrome: chrome });
      expect(parsed.success, `${chrome} should be accepted`).toBe(true);
    }
  });

  it('rejects a mode that does not exist', () => {
    expect(updateConfigSchema.safeParse({ respondentChrome: 'kiosk_mode' }).success).toBe(false);
  });

  it('leaves the field untouched when it is omitted', () => {
    // The PATCH body is all-optional; a save that does not mention chrome must not reset it.
    const parsed = updateConfigSchema.safeParse({ presentationMode: 'chat' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect('respondentChrome' in parsed.data).toBe(false);
  });
});
