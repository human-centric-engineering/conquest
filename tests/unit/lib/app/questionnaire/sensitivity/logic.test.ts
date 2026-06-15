/**
 * Sensitivity awareness — pure severity + signpost logic.
 *
 * Pins the running-max escalation (never downgrades; null prior adopts this turn), the
 * once-per-session signpost trigger, and the verbatim support-message assembly. Zero mocks.
 */

import { describe, it, expect } from 'vitest';

import {
  severityRank,
  runningMaxLevel,
  shouldSignpost,
  composeSupportMessage,
  effectiveSupportMessage,
  DEFAULT_SUPPORT_MESSAGE,
} from '@/lib/app/questionnaire/sensitivity';

describe('severityRank', () => {
  it('orders low < medium < high', () => {
    expect(severityRank('low')).toBeLessThan(severityRank('medium'));
    expect(severityRank('medium')).toBeLessThan(severityRank('high'));
  });
});

describe('runningMaxLevel', () => {
  it('adopts this turn’s severity when there is no prior level', () => {
    expect(runningMaxLevel(null, 'low')).toBe('low');
    expect(runningMaxLevel(undefined, 'high')).toBe('high');
  });

  it('rises but never downgrades', () => {
    expect(runningMaxLevel('low', 'high')).toBe('high');
    expect(runningMaxLevel('high', 'low')).toBe('high'); // a later milder disclosure can't lower it
    expect(runningMaxLevel('medium', 'medium')).toBe('medium'); // idempotent
    expect(runningMaxLevel('medium', 'high')).toBe('high');
    expect(runningMaxLevel('high', 'medium')).toBe('high');
  });
});

describe('shouldSignpost', () => {
  it('fires only when this turn first reaches high', () => {
    expect(shouldSignpost(null, 'high')).toBe(true);
    expect(shouldSignpost('low', 'high')).toBe(true);
    expect(shouldSignpost('medium', 'high')).toBe(true);
  });

  it('does not fire again once the session is already high (once-per-session)', () => {
    expect(shouldSignpost('high', 'high')).toBe(false);
  });

  it('does not fire for low/medium disclosures', () => {
    expect(shouldSignpost(null, 'low')).toBe(false);
    expect(shouldSignpost('low', 'medium')).toBe(false);
  });
});

describe('composeSupportMessage', () => {
  it('returns the trimmed message alone when no URL', () => {
    expect(composeSupportMessage('  Support is available.  ', '')).toBe('Support is available.');
    expect(composeSupportMessage('Help is here.', '   ')).toBe('Help is here.');
  });

  it('appends a resource URL when set', () => {
    expect(composeSupportMessage('Support is available.', 'https://help.example')).toBe(
      'Support is available. https://help.example'
    );
  });
});

describe('effectiveSupportMessage', () => {
  it('uses the authored message when present', () => {
    expect(effectiveSupportMessage('  Reach our team anytime.  ')).toBe('Reach our team anytime.');
  });

  it('falls back to the reviewed default when blank (no silent empty-message footgun)', () => {
    expect(effectiveSupportMessage('')).toBe(DEFAULT_SUPPORT_MESSAGE);
    expect(effectiveSupportMessage('   ')).toBe(DEFAULT_SUPPORT_MESSAGE);
  });
});
