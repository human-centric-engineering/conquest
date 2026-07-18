/**
 * buildIntroCopy — pure derivation of the respondent intro copy from a version's settings.
 *
 * Pins the full matrix the splash depends on: how-it-works per presentation mode, what-you'll-get
 * per report mode × delivery combination (and omission when the report is off), the conditional
 * good-to-know notes, and the per-mode button-label default vs admin override.
 *
 * @see lib/app/questionnaire/intro/copy.ts
 */

import { describe, it, expect } from 'vitest';

import { buildIntroCopy, type IntroCopyInput } from '@/lib/app/questionnaire/intro/copy';
import {
  DEFAULT_RESPONDENT_REPORT_SETTINGS,
  type PresentationMode,
  type RespondentReportMode,
  type RespondentReportSettings,
} from '@/lib/app/questionnaire/types';

/** A report settings block with overridable mode/enabled/delivery. */
function report(over: Partial<RespondentReportSettings> = {}): RespondentReportSettings {
  return { ...DEFAULT_RESPONDENT_REPORT_SETTINGS, ...over };
}

/** Base copy input — report off, named, no voice, no button override. */
function input(over: Partial<IntroCopyInput> = {}): IntroCopyInput {
  return {
    presentationMode: 'chat',
    report: report(),
    anonymousMode: false,
    voiceEnabled: false,
    buttonLabelOverride: '',
    ...over,
  };
}

describe('buildIntroCopy — how it works', () => {
  it.each<[PresentationMode, RegExp]>([
    ['chat', /conversation, not a form/i],
    ['form', /grouped into sections/i],
    ['both', /switch between the two/i],
  ])('gives mode-specific guidance for %s', (presentationMode, bodyMatch) => {
    const copy = buildIntroCopy(input({ presentationMode }));
    expect(copy.howItWorks.heading).toBe('How it works');
    expect(copy.howItWorks.body).toMatch(bodyMatch);
  });

  it('produces a distinct body for each mode (no copy/paste collisions)', () => {
    const bodies = (['chat', 'form', 'both'] as PresentationMode[]).map(
      (m) => buildIntroCopy(input({ presentationMode: m })).howItWorks.body
    );
    expect(new Set(bodies).size).toBe(3);
  });
});

describe('buildIntroCopy — what you’ll get', () => {
  it('omits the section entirely when the report is disabled', () => {
    expect(buildIntroCopy(input({ report: report({ enabled: false }) })).whatYouGet).toBeNull();
  });

  it.each<[RespondentReportMode, RegExp]>([
    ['raw', /summary of everything you shared/i],
    ['raw_plus_insights', /tailored insights section/i],
    ['narrative', /personalised written report/i],
  ])('describes the %s deliverable when enabled', (mode, bodyMatch) => {
    const copy = buildIntroCopy(input({ report: report({ enabled: true, mode }) }));
    expect(copy.whatYouGet).not.toBeNull();
    expect(copy.whatYouGet!.body).toMatch(bodyMatch);
  });

  it('only the AI modes mention the post-submit wait', () => {
    const raw = buildIntroCopy(input({ report: report({ enabled: true, mode: 'raw' }) }));
    const ai = buildIntroCopy(
      input({ report: report({ enabled: true, mode: 'raw_plus_insights' }) })
    );
    expect(raw.whatYouGet!.body).not.toMatch(/may take a moment/i);
    expect(ai.whatYouGet!.body).toMatch(/may take a moment/i);
  });

  it.each<[boolean, boolean, RegExp]>([
    [true, true, /view on screen and download as a PDF/i],
    [true, false, /to view on screen(?!.*PDF)/i],
    [false, true, /download as a PDF/i],
  ])('reflects delivery onScreen=%s download=%s', (onScreen, download, match) => {
    const copy = buildIntroCopy(
      input({
        report: report({
          enabled: true,
          mode: 'raw',
          delivery: { onScreen, download, explainMethod: false },
        }),
      })
    );
    expect(copy.whatYouGet!.body).toMatch(match);
  });

  it('adds no delivery clause when neither on-screen nor download is offered', () => {
    const copy = buildIntroCopy(
      input({
        report: report({
          enabled: true,
          mode: 'raw',
          delivery: { onScreen: false, download: false, explainMethod: false },
        }),
      })
    );
    expect(copy.whatYouGet!.body).not.toMatch(/screen|PDF/i);
  });
});

describe('buildIntroCopy — good to know', () => {
  it('always includes the honesty note', () => {
    expect(buildIntroCopy(input()).goodToKnow[0]).toMatch(/no right or wrong answers/i);
  });

  it('adds the anonymity note only when anonymous', () => {
    expect(buildIntroCopy(input({ anonymousMode: false })).goodToKnow.join(' ')).not.toMatch(
      /anonymous/i
    );
    expect(buildIntroCopy(input({ anonymousMode: true })).goodToKnow.join(' ')).toMatch(
      /anonymous/i
    );
  });

  it('adds the voice note only when voice is enabled', () => {
    expect(buildIntroCopy(input({ voiceEnabled: false })).goodToKnow.join(' ')).not.toMatch(/mic/i);
    expect(buildIntroCopy(input({ voiceEnabled: true })).goodToKnow.join(' ')).toMatch(/mic/i);
  });
});

describe('buildIntroCopy — button label', () => {
  it.each<[PresentationMode, string]>([
    ['chat', 'Start the conversation'],
    ['form', 'Start the questionnaire'],
    ['both', 'Get started'],
  ])('uses the %s default when no override is set', (presentationMode, label) => {
    expect(buildIntroCopy(input({ presentationMode })).buttonLabel).toBe(label);
  });

  it('uses (trimmed) admin override over the default', () => {
    expect(buildIntroCopy(input({ buttonLabelOverride: '  Begin now  ' })).buttonLabel).toBe(
      'Begin now'
    );
  });

  it('falls back to the default when the override is blank/whitespace', () => {
    expect(
      buildIntroCopy(input({ presentationMode: 'form', buttonLabelOverride: '   ' })).buttonLabel
    ).toBe('Start the questionnaire');
  });
});
