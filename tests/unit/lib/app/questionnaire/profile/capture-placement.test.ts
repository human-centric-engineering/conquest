/**
 * Unit test: respondent profile capture placement split (F-capture, hybrid).
 *
 * Pure module — no mocks. Covers the per-field placement resolution (`captureVia` override vs the
 * version default), the form/conversational partition that makes a questionnaire hybrid, the
 * `conversationalCaptureActive` rule the interviewer uses to decide whether to keep gathering the
 * conversational subset (required fields keep it alive; optionals are taken as-offered), and
 * `conversationalCaptureFieldsForConfig` — the full config→conversational-subset assembly the
 * interviewer turn loop relies on (anonymous guard + mode narrowing + parse + split).
 */

import { describe, it, expect } from 'vitest';

import {
  effectiveCaptureVia,
  splitFieldsByPlacement,
  conversationalCaptureActive,
  conversationalCaptureFieldsForConfig,
} from '@/lib/app/questionnaire/profile/capture-placement';
import type { ProfileFieldConfig } from '@/lib/app/questionnaire/types';

const field = (over: Partial<ProfileFieldConfig> & { key: string }): ProfileFieldConfig => ({
  label: over.key,
  type: 'text',
  required: false,
  validation: 'deterministic',
  ...over,
});

describe('effectiveCaptureVia', () => {
  it("uses the field's own captureVia override when set", () => {
    expect(effectiveCaptureVia(field({ key: 'a', captureVia: 'conversational' }), 'form')).toBe(
      'conversational'
    );
  });

  it('falls back to the version default when the field has no override', () => {
    expect(effectiveCaptureVia(field({ key: 'a' }), 'conversational')).toBe('conversational');
    expect(effectiveCaptureVia(field({ key: 'a' }), 'form')).toBe('form');
  });
});

describe('splitFieldsByPlacement', () => {
  it('partitions a hybrid set on effective placement, preserving authored order', () => {
    const fields = [
      field({ key: 'name', captureVia: 'form' }),
      field({ key: 'org' }), // inherits the default
      field({ key: 'email', captureVia: 'form' }),
      field({ key: 'role', captureVia: 'conversational' }),
    ];
    const { formFields, conversationalFields } = splitFieldsByPlacement(fields, 'conversational');
    expect(formFields.map((f) => f.key)).toEqual(['name', 'email']);
    expect(conversationalFields.map((f) => f.key)).toEqual(['org', 'role']);
  });

  it('routes every field to form when the default is form and nothing overrides', () => {
    const fields = [field({ key: 'a' }), field({ key: 'b' })];
    const { formFields, conversationalFields } = splitFieldsByPlacement(fields, 'form');
    expect(formFields).toHaveLength(2);
    expect(conversationalFields).toHaveLength(0);
  });
});

describe('conversationalCaptureActive', () => {
  const conv = [field({ key: 'name', required: true }), field({ key: 'org', required: false })];

  it('is inactive when there is no conversational subset', () => {
    expect(conversationalCaptureActive([], {})).toBe(false);
  });

  it('is active while a required conversational field is still missing', () => {
    expect(conversationalCaptureActive(conv, {})).toBe(true);
    expect(conversationalCaptureActive(conv, { org: 'Acme' })).toBe(true); // required name still absent
  });

  it('goes quiet once every required conversational field is captured', () => {
    expect(conversationalCaptureActive(conv, { name: 'Ada' })).toBe(false);
  });

  it('for an all-optional subset, stays active until the first value lands, then quiets', () => {
    const optional = [field({ key: 'org' }), field({ key: 'role' })];
    expect(conversationalCaptureActive(optional, {})).toBe(true); // one opportunistic pass
    expect(conversationalCaptureActive(optional, { org: 'Acme' })).toBe(false); // let the rest go
  });

  it('treats a blank stored value as not captured', () => {
    expect(conversationalCaptureActive(conv, { name: '   ' })).toBe(true);
  });
});

describe('conversationalCaptureFieldsForConfig', () => {
  const profileFields = [
    { key: 'name', label: 'Name', type: 'text', required: true, captureVia: 'form' },
    { key: 'org', label: 'Org', type: 'text', required: false, captureVia: 'conversational' },
    { key: 'role', label: 'Role', type: 'text', required: false }, // inherits the default mode
  ];

  it('returns an empty subset for an anonymous version (PII-free — never gathers conversationally)', () => {
    expect(
      conversationalCaptureFieldsForConfig({
        anonymousMode: true,
        captureMode: 'conversational',
        profileFields,
      })
    ).toEqual([]);
  });

  it('with a form default, only fields overridden to conversational are gathered in-chat', () => {
    const fields = conversationalCaptureFieldsForConfig({
      anonymousMode: false,
      captureMode: 'form',
      profileFields,
    });
    expect(fields.map((f) => f.key)).toEqual(['org']); // name=form override, role inherits form
  });

  it('with a conversational default, inheriting fields join the overridden ones (hybrid)', () => {
    const fields = conversationalCaptureFieldsForConfig({
      anonymousMode: false,
      captureMode: 'conversational',
      profileFields,
    });
    expect(fields.map((f) => f.key)).toEqual(['org', 'role']); // name stays on the form gate
  });

  it('narrows an unknown/absent stored captureMode to the form default (inheriting fields → form)', () => {
    const fields = conversationalCaptureFieldsForConfig({
      anonymousMode: false,
      captureMode: 'telepathy',
      profileFields: [{ key: 'role', label: 'Role', type: 'text', required: false }],
    });
    expect(fields).toEqual([]); // inherits form (the narrowed default), so nothing is conversational
  });

  it('returns an empty subset when there are no profile fields', () => {
    expect(
      conversationalCaptureFieldsForConfig({
        anonymousMode: false,
        captureMode: 'conversational',
        profileFields: [],
      })
    ).toEqual([]);
  });
});
