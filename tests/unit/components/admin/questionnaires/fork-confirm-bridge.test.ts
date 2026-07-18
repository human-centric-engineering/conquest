/**
 * fork-confirm-bridge — the module-level handoff between `authoringMutate` (a plain function) and the
 * mounted `ForkConfirmProvider`. Covers the branches the provider test can't reach:
 *  - no handler registered → requestForkConfirm resolves false (never fork silently)
 *  - a registered handler receives the details and its result is returned
 *  - the unregister returned by register clears only the matching handler
 *
 * @see components/admin/questionnaires/fork-confirm-bridge.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  parseForkConfirmDetails,
  registerForkConfirmHandler,
  requestForkConfirm,
  type ForkConfirmDetails,
} from '@/components/admin/questionnaires/fork-confirm-bridge';

const DETAILS: ForkConfirmDetails = {
  sourceVersionNumber: 1,
  nextVersionNumber: 2,
  versions: [{ versionNumber: 1, status: 'launched' }],
};

const DECLINED = { confirmed: false, archiveSource: false };
const CONFIRMED = { confirmed: true, archiveSource: false };
const CONFIRMED_ARCHIVE = { confirmed: true, archiveSource: true };

// Leave the module-level handler slot clean between tests.
afterEach(() => {
  registerForkConfirmHandler(() => Promise.resolve(DECLINED))();
});

describe('fork-confirm-bridge', () => {
  it('resolves declined when no handler is registered (never forks silently)', async () => {
    // Ensure the slot is empty: register then immediately unregister.
    registerForkConfirmHandler(() => Promise.resolve(CONFIRMED))();
    await expect(requestForkConfirm(DETAILS)).resolves.toEqual(DECLINED);
  });

  it('forwards the details to the registered handler and returns its choice', async () => {
    const handler = vi.fn(() => Promise.resolve(CONFIRMED_ARCHIVE));
    registerForkConfirmHandler(handler);

    await expect(requestForkConfirm(DETAILS)).resolves.toEqual(CONFIRMED_ARCHIVE);
    expect(handler).toHaveBeenCalledWith(DETAILS);
  });

  it('unregister only clears the handler it was issued for', async () => {
    const first = vi.fn(() => Promise.resolve(CONFIRMED));
    const unregisterFirst = registerForkConfirmHandler(first);
    // A newer handler replaces the slot; the first's unregister must NOT clear it.
    const second = vi.fn(() => Promise.resolve(DECLINED));
    registerForkConfirmHandler(second);

    unregisterFirst();

    await expect(requestForkConfirm(DETAILS)).resolves.toEqual(DECLINED);
    expect(second).toHaveBeenCalledWith(DETAILS);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('parseForkConfirmDetails', () => {
  it('returns the typed details for a well-formed server envelope', () => {
    expect(parseForkConfirmDetails(DETAILS)).toEqual(DETAILS);
  });

  it('returns null when a field is missing or the wrong type (deploy skew)', () => {
    expect(parseForkConfirmDetails({ sourceVersionNumber: 1, nextVersionNumber: 2 })).toBeNull();
    expect(
      parseForkConfirmDetails({ sourceVersionNumber: '1', nextVersionNumber: 2, versions: [] })
    ).toBeNull();
    expect(parseForkConfirmDetails(undefined)).toBeNull();
  });

  it('returns null when a version status is not a known enum value', () => {
    expect(
      parseForkConfirmDetails({
        sourceVersionNumber: 1,
        nextVersionNumber: 2,
        versions: [{ versionNumber: 1, status: 'bogus' }],
      })
    ).toBeNull();
  });
});
