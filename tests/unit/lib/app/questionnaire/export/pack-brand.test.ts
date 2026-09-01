/**
 * pack-brand — unit tests for the Questionnaire Pack's shared brand data and date formatter.
 *
 * `formatPackDate` exists because every date the pack printed was a raw ISO string — "Last run
 * 2026-08-30T09:12:44.118Z" over a judge scoreboard in a document written for a client. The
 * properties worth pinning are the ones that make a document's timestamp trustworthy: it always
 * carries the year, it does not move with the host's timezone, and it names the zone it is in.
 *
 * @see lib/app/questionnaire/export/pack-brand.ts
 */

import { describe, it, expect } from 'vitest';

import { formatPackDate, PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';

describe('formatPackDate', () => {
  it('writes a date a person can read, with the year and the zone named', () => {
    expect(formatPackDate('2026-08-11T09:12:44.118Z')).toBe('11 Aug 2026, 09:12 UTC');
  });

  it('keeps the year even for a timestamp in the current year', () => {
    // The distinction from `formatCompactDateTime`, which drops it. A pack is filed and reopened
    // months later, where "11 Aug" alone is a date the reader cannot place.
    const thisYear = new Date().getFullYear();
    const formatted = formatPackDate(`${thisYear}-08-11T09:12:44.118Z`);
    expect(formatted).toContain(String(thisYear));
  });

  it('does not move with the host timezone, so a late-evening run keeps its date', () => {
    // 23:30 UTC is the following day in Berlin and the same day in London. Left to the ambient
    // zone, the same run would print as a different DAY depending on which region rendered the
    // pack — on a document somebody may be reading as a record of when a panel ran.
    expect(formatPackDate('2026-08-11T23:30:00.000Z')).toBe('11 Aug 2026, 23:30 UTC');
  });

  it('returns null for a missing timestamp so the caller can word the absence itself', () => {
    expect(formatPackDate(null)).toBeNull();
  });

  it('returns null rather than "Invalid Date" for an unparseable value', () => {
    // `runAt` reaches here from a stored column. A malformed one must degrade to the caller's own
    // "date unknown" wording, never print the string `Invalid Date` into a client-facing PDF.
    expect(formatPackDate('not-a-date')).toBeNull();
  });
});

describe('PACK_BRAND', () => {
  it('is the single authored source for the tagline, website and closing blurb', () => {
    // Three serialisers read these. A fork MUST edit this file rather than the serialisers.
    expect(PACK_BRAND.tagline).toBe('Conversational Questionnaires');
    expect(PACK_BRAND.website).toBe('conquestinsights.com');
    expect(PACK_BRAND.closingHeading).toBe('About ConQuest');
    expect(PACK_BRAND.closingBlurb.length).toBeGreaterThan(0);
  });
});
