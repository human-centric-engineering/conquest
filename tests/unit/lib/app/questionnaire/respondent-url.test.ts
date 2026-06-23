import { describe, expect, it } from 'vitest';

import {
  FRICTIONLESS_INVITE_PARAM,
  respondentPublicPath,
} from '@/lib/app/questionnaire/respondent-url';

describe('respondentPublicPath', () => {
  it('builds the no-login surface path for a version', () => {
    expect(respondentPublicPath('ver_123')).toBe('/q/ver_123');
  });

  it('does not append a token query param (the public link is tokenless)', () => {
    expect(respondentPublicPath('ver_123')).not.toContain('?');
  });
});

describe('FRICTIONLESS_INVITE_PARAM', () => {
  it('is the "i" query key the public page reads for a per-invite token', () => {
    expect(FRICTIONLESS_INVITE_PARAM).toBe('i');
  });
});
