/**
 * Finding severity / review-status labels — the words every reader-facing surface uses.
 *
 * These maps live in `lib/` rather than beside the admin badge component because the Questionnaire
 * Pack needs the same words and `lib/` cannot import from `components/`. Before they existed the
 * console showed "Major" while a client-facing PDF printed `major`, and `[minor · pending]` appeared
 * on nearly every line of the pack's evaluation appendix.
 *
 * Test Coverage:
 * - Every value in each tuple has a label (a new severity or status cannot ship unlabelled)
 * - The admin badge descriptors take their labels from these maps, so the two cannot drift
 * - `decidedStatusLabel` suppresses `pending` and only `pending`
 * - Both label helpers degrade an unrecognised stored value to itself, never to `undefined`
 *
 * @see lib/app/questionnaire/evaluation/types.ts
 */

import { describe, it, expect } from 'vitest';

import {
  FINDING_REVIEW_STATUS_LABELS,
  FINDING_REVIEW_STATUSES,
  FINDING_SEVERITIES,
  FINDING_SEVERITY_LABELS,
  decidedStatusLabel,
  findingSeverityLabel,
} from '@/lib/app/questionnaire/evaluation';
import {
  FINDING_REVIEW_STATUS_BADGE,
  FINDING_SEVERITY_BADGE,
} from '@/components/admin/questionnaires/evaluation-status-badge';

describe('finding label maps', () => {
  it('labels every severity in the tuple', () => {
    for (const severity of FINDING_SEVERITIES) {
      expect(FINDING_SEVERITY_LABELS[severity]).toBeTruthy();
    }
  });

  it('labels every review status in the tuple', () => {
    for (const status of FINDING_REVIEW_STATUSES) {
      expect(FINDING_REVIEW_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it('is where the admin badges get their words, so the console and the pack cannot disagree', () => {
    // The point of the maps. A second hand-written label table in the badge module is exactly what
    // would let a PDF say `major` while the screen beside it says "Major".
    for (const severity of FINDING_SEVERITIES) {
      expect(FINDING_SEVERITY_BADGE[severity].label).toBe(FINDING_SEVERITY_LABELS[severity]);
    }
    for (const status of FINDING_REVIEW_STATUSES) {
      expect(FINDING_REVIEW_STATUS_BADGE[status].label).toBe(FINDING_REVIEW_STATUS_LABELS[status]);
    }
  });
});

describe('findingSeverityLabel', () => {
  it('labels a known severity', () => {
    expect(findingSeverityLabel('major')).toBe('Major');
  });

  it('returns an unrecognised stored value as itself rather than undefined', () => {
    // `severity` is a plain String column, so a future or anomalous value must degrade to a raw
    // key in the document rather than printing "undefined" into a client-facing PDF.
    expect(findingSeverityLabel('catastrophic')).toBe('catastrophic');
  });
});

describe('decidedStatusLabel', () => {
  it('returns null for pending, which is the state of nearly every finding in an untriaged run', () => {
    // Saying "Pending" on every line costs the reader a word to skip and tells them nothing. The
    // console's badge row drops it for the same reason.
    expect(decidedStatusLabel('pending')).toBeNull();
  });

  it('names a decision somebody actually recorded', () => {
    expect(decidedStatusLabel('accepted')).toBe('Accepted');
    expect(decidedStatusLabel('declined')).toBe('Declined');
    expect(decidedStatusLabel('applied')).toBe('Applied');
  });

  it('suppresses only pending, so a new status is visible rather than silently dropped', () => {
    const suppressed = FINDING_REVIEW_STATUSES.filter((s) => decidedStatusLabel(s) === null);
    expect(suppressed).toEqual(['pending']);
  });

  it('returns an unrecognised stored value as itself', () => {
    expect(decidedStatusLabel('superseded')).toBe('superseded');
  });
});
