/**
 * keywordSensitivityFloor — unit tests.
 *
 * Pure, deterministic safety net: a string in, a high-severity assessment or undefined out. No
 * mocks. The net is the non-LLM floor that catches a plain first-person harm disclosure (or an
 * unambiguous self-harm phrase) even when the LLM detector misses or fails.
 *
 * @see lib/app/questionnaire/sensitivity/keyword-net.ts
 */

import { describe, it, expect } from 'vitest';

import {
  keywordSensitivityFloor,
  KEYWORD_NET_SUMMARY,
} from '@/lib/app/questionnaire/sensitivity/keyword-net';

describe('keywordSensitivityFloor — flags first-person harm', () => {
  it('flags the canonical missed disclosure "i\'m being abused by my manager" as high', () => {
    const out = keywordSensitivityFloor("i'm being abused by my manager");
    expect(out).toBeDefined();
    expect(out!.severity).toBe('high');
    expect(out!.detected).toBe(true);
    // The net never carries graphic detail — a fixed, safe summary.
    expect(out!.summary).toBe(KEYWORD_NET_SUMMARY);
  });

  it.each([
    'I was bullied by a colleague',
    'I am being harassed at work',
    'my boss threatened me',
    'I feel unsafe here',
    'I have been discriminated against',
    'I was assaulted',
  ])('flags %j as a high-severity disclosure', (message) => {
    const out = keywordSensitivityFloor(message);
    expect(out?.severity).toBe('high');
  });
});

describe('keywordSensitivityFloor — self-harm phrases stand alone', () => {
  it.each([
    'I want to kill myself',
    'I have been having suicidal thoughts',
    'sometimes I want to end my life',
    'I keep hurting myself',
  ])('flags %j with the self-harm category', (message) => {
    const out = keywordSensitivityFloor(message);
    expect(out?.severity).toBe('high');
    expect(out?.category).toBe('self-harm');
  });
});

describe('keywordSensitivityFloor — avoids obvious false positives', () => {
  it.each([
    // A harm WORD with no first-person victim marker — an opinion about the survey, not a disclosure.
    'this survey is harassment',
    // Ordinary criticism / negativity.
    'management doesn’t listen',
    'the tools are clunky and morale is low',
    // Plain hostility / profanity with no disclosure — that is the seriousness gate's job, not
    // safeguarding (the exact case that must still fall through to the gate).
    'this is a stupid survey',
    'go fuck yourself',
    '',
  ])('does NOT flag %j', (message) => {
    expect(keywordSensitivityFloor(message)).toBeUndefined();
  });

  it('errs toward catching when a first-person marker sits near a harm word (acceptable over-flag)', () => {
    // The net is deliberately crude: a false positive costs only an unneeded gentle tone + signpost,
    // whereas a false negative could drop a real disclosure. So "abusive of my time" trips it — and
    // that is the documented, intended bias, not a bug.
    expect(keywordSensitivityFloor('the process is abusive of my time')).toBeDefined();
  });
});
