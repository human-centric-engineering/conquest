/**
 * Tests for the fork-owned hook event namespace (#465).
 *
 * `HOOK_EVENT_TYPES` was a closed list, so a fork could neither emit its own
 * domain event nor subscribe a webhook to one. The fix widens the type and the
 * validator to `app.*` / `framework.*`.
 *
 * What matters here is that the widening did not become a hole: the core enum
 * must still be enforced, and an un-namespaced string must still be rejected —
 * this schema also validates `AiEventHookDelivery.payload` read back from the DB.
 */

import { describe, it, expect } from 'vitest';
import {
  hookEventTypeSchema,
  HookEventPayloadSchema,
  HOOK_EVENT_TYPES,
  FORK_EVENT_TYPE_PATTERN,
} from '@/lib/orchestration/hooks/types';

describe('hookEventTypeSchema', () => {
  it('accepts every core event type', () => {
    for (const type of HOOK_EVENT_TYPES) {
      expect(hookEventTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it.each([
    'app.invoice.paid',
    'app.something',
    'framework.tenant.provisioned',
    'app.a-b_c.d',
    'framework.x',
  ])('accepts the fork-namespaced type %s', (type) => {
    expect(hookEventTypeSchema.safeParse(type).success).toBe(true);
  });

  it.each([
    ['an unknown bare word', 'invoice.paid'],
    ['an unknown dotted name outside the namespaces', 'billing.invoice.paid'],
    ['the prefix with no event', 'app.'],
    ['the prefix without a dot', 'appinvoice'],
    ['a nested prefix', 'x.app.invoice'],
    ['an empty string', ''],
    ['a near-miss prefix', 'apps.invoice'],
  ])('rejects %s', (_label, type) => {
    // The widening must not degrade to "any string" — this schema is the check
    // on hook payloads read back from the database.
    expect(hookEventTypeSchema.safeParse(type).success).toBe(false);
  });

  it('rejects a type with characters that are not name-safe', () => {
    expect(hookEventTypeSchema.safeParse('app.invoice paid').success).toBe(false);
    expect(hookEventTypeSchema.safeParse('app.invoice/paid').success).toBe(false);
  });
});

describe('FORK_EVENT_TYPE_PATTERN', () => {
  it('is anchored at both ends', () => {
    // An unanchored pattern would let `x.app.y` and `app.y.<newline>evil` through.
    expect(FORK_EVENT_TYPE_PATTERN.test('app.ok')).toBe(true);
    expect(FORK_EVENT_TYPE_PATTERN.test('prefix-app.ok')).toBe(false);
    expect(FORK_EVENT_TYPE_PATTERN.test('app.ok suffix')).toBe(false);
  });

  it('does not collide with any core event type', () => {
    // Sunrise must never emit into the fork namespaces, or the guarantee that a
    // fork's names cannot clash with a future release is void.
    for (const type of HOOK_EVENT_TYPES) {
      expect(FORK_EVENT_TYPE_PATTERN.test(type)).toBe(false);
    }
  });
});

describe('HookEventPayloadSchema', () => {
  const base = { timestamp: new Date().toISOString(), data: { any: 'thing' } };

  it('validates a queued retry for a fork event', () => {
    // Before the widening this row would fail revalidation and the delivery
    // would be dropped as malformed.
    const result = HookEventPayloadSchema.safeParse({ ...base, eventType: 'app.invoice.paid' });
    expect(result.success).toBe(true);
  });

  it('still validates a core event', () => {
    const result = HookEventPayloadSchema.safeParse({
      ...base,
      eventType: HOOK_EVENT_TYPES[0],
    });
    expect(result.success).toBe(true);
  });

  it('still rejects an unnamespaced unknown event', () => {
    const result = HookEventPayloadSchema.safeParse({ ...base, eventType: 'made.up' });
    expect(result.success).toBe(false);
  });
});
