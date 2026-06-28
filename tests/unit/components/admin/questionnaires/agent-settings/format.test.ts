/**
 * Unit test: the Agent Settings card number formatters.
 */

import { describe, it, expect } from 'vitest';

import {
  formatUsd,
  formatPerMillion,
  formatPct,
  formatTemperature,
} from '@/components/admin/questionnaires/agent-settings/format';

describe('formatUsd', () => {
  it('renders dashes, zero, tiny and normal values', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0001)).toBe('$0.0001');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});

describe('formatPerMillion', () => {
  it('renders a $/M rate or a dash', () => {
    expect(formatPerMillion(null)).toBe('—');
    expect(formatPerMillion(2.625)).toBe('$2.63/M');
  });
});

describe('formatPct', () => {
  it('signs positive deltas and dashes nulls', () => {
    expect(formatPct(null)).toBe('—');
    expect(formatPct(5)).toBe('+5%');
    expect(formatPct(-72)).toBe('-72%');
  });
});

describe('formatTemperature', () => {
  it('renders one decimal or a dash', () => {
    expect(formatTemperature(null)).toBe('—');
    expect(formatTemperature(0.5)).toBe('0.5');
  });
});
