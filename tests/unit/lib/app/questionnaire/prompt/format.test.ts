/**
 * Shared prompt-formatter tests.
 *
 * These pin the one contract every consumer relies on — optional/empty input collapses to '' so
 * absent sections add nothing — plus the structural output (tag wrapping, blank-line section gaps,
 * list markers).
 *
 * @see lib/app/questionnaire/prompt/format.ts
 */

import { describe, it, expect } from 'vitest';

import {
  bulletList,
  joinSections,
  jsonOutputContract,
  numberedList,
  section,
  titledBlock,
} from '@/lib/app/questionnaire/prompt/format';

describe('section', () => {
  it('wraps a non-empty body in the tag with tidy newlines', () => {
    expect(section('role', 'You are an interviewer.')).toBe(
      '<role>\nYou are an interviewer.\n</role>'
    );
  });

  it('collapses an empty or whitespace body to an empty string', () => {
    expect(section('tone', '')).toBe('');
    expect(section('tone', '   \n  ')).toBe('');
  });
});

describe('joinSections', () => {
  it('joins non-empty parts with a blank line and drops falsy/empty ones', () => {
    expect(joinSections('a', '', false, null, undefined, 'b')).toBe('a\n\nb');
  });

  it('returns an empty string when every part is empty', () => {
    expect(joinSections('', false, null)).toBe('');
  });
});

describe('bulletList / numberedList', () => {
  it('renders bullets and skips empty items', () => {
    expect(bulletList(['one', '', 'two'])).toBe('- one\n- two');
  });

  it('renders a 1-based numbered list over the surviving items', () => {
    expect(numberedList(['a', '', 'b', 'c'])).toBe('1. a\n2. b\n3. c');
  });
});

describe('titledBlock', () => {
  it('renders Title:\\n<body>, or "" for an empty body', () => {
    expect(titledBlock('Recent conversation', '- hi')).toBe('Recent conversation:\n- hi');
    expect(titledBlock('Recent conversation', '')).toBe('');
  });
});

describe('jsonOutputContract', () => {
  it('prefaces the literal shape and keeps it verbatim', () => {
    const out = jsonOutputContract('{"choice": <n>, "rationale": "<s>"}');
    expect(out).toContain('Respond with ONLY this JSON object');
    expect(out).toContain('{"choice": <n>, "rationale": "<s>"}');
  });

  it('honours a custom preface + trailer', () => {
    const out = jsonOutputContract('{"x": 1}', { preface: 'Output', trailer: 'No prose.' });
    expect(out).toBe('Output:\n{"x": 1} No prose.');
  });
});
