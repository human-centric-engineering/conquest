/**
 * Unit test: evaluation status/severity/review badge resolvers (F5.2 + F5.3). Pins the known
 * mappings and the defensive `UNKNOWN_*` fallback for an unexpected stored value (the columns are
 * plain Strings validated at the seam, so the UI must never throw on an anomalous one).
 */

import { describe, it, expect } from 'vitest';

import {
  runStatusBadge,
  findingSeverityBadge,
  findingReviewStatusBadge,
} from '@/components/admin/questionnaires/evaluation-status-badge';

describe('runStatusBadge', () => {
  it('maps known run statuses', () => {
    expect(runStatusBadge('completed').label).toBe('Completed');
    expect(runStatusBadge('partial').label).toBe('Partial');
    expect(runStatusBadge('failed').variant).toBe('destructive');
  });
  it('falls back to Unknown for an unexpected value', () => {
    expect(runStatusBadge('weird').label).toBe('Unknown');
  });
});

describe('findingSeverityBadge', () => {
  it('maps known severities', () => {
    expect(findingSeverityBadge('major').variant).toBe('destructive');
    expect(findingSeverityBadge('minor').label).toBe('Minor');
    expect(findingSeverityBadge('info').label).toBe('Info');
  });
  it('falls back to Unknown', () => {
    expect(findingSeverityBadge('catastrophic').label).toBe('Unknown');
  });
});

describe('findingReviewStatusBadge', () => {
  it('maps known review statuses', () => {
    expect(findingReviewStatusBadge('pending').label).toBe('Pending');
    expect(findingReviewStatusBadge('accepted').label).toBe('Accepted');
    expect(findingReviewStatusBadge('declined').label).toBe('Declined');
    expect(findingReviewStatusBadge('applied').variant).toBe('default');
  });
  it('falls back to Unknown for an unexpected value (e.g. a derived flag leaking in)', () => {
    expect(findingReviewStatusBadge('stale').label).toBe('Unknown');
  });
});
