/**
 * Tests for the storage capability contract (sunrise#490).
 *
 * The contract's whole value is that an *undeclared* capability reads as
 * "cannot", not "unknown" — that is what lets a fork's custom provider keep
 * compiling when a capability is added upstream without silently claiming
 * support for it. These tests pin that default.
 *
 * @see lib/storage/providers/types.ts
 * @see .context/storage/overview.md
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STORAGE_CAPABILITIES,
  getStorageCapabilities,
  type StorageProvider,
} from '@/lib/storage/providers/types';

/** A provider stub — only `capabilities` matters to these tests. */
function providerWith(capabilities?: StorageProvider['capabilities']): StorageProvider {
  return {
    name: 'stub',
    ...(capabilities ? { capabilities } : {}),
    upload: async () => ({ key: 'k', url: 'u', size: 0 }),
    delete: async () => ({ success: true, key: 'k' }),
    deletePrefix: async () => ({ success: true, key: 'k' }),
  };
}

describe('DEFAULT_STORAGE_CAPABILITIES', () => {
  it('denies every capability', () => {
    expect(DEFAULT_STORAGE_CAPABILITIES).toEqual({
      privateObjects: false,
      signedUrls: false,
      download: false,
    });
  });
});

describe('getStorageCapabilities', () => {
  it('returns all-false for a provider that declares nothing', () => {
    // The fork-upgrade case: a custom provider written before capabilities
    // existed must not be read as capable of anything.
    expect(getStorageCapabilities(providerWith())).toEqual({
      privateObjects: false,
      signedUrls: false,
      download: false,
    });
  });

  it('fills undeclared capabilities with false rather than undefined', () => {
    const caps = getStorageCapabilities(providerWith({ signedUrls: true }));

    expect(caps.signedUrls).toBe(true);
    // Not undefined — callers branch on these directly.
    expect(caps.privateObjects).toBe(false);
    expect(caps.download).toBe(false);
  });

  it('honours an explicit false over the default', () => {
    const caps = getStorageCapabilities(
      providerWith({ privateObjects: false, signedUrls: false, download: false })
    );

    expect(caps).toEqual({ privateObjects: false, signedUrls: false, download: false });
  });

  it('passes through a fully capable provider', () => {
    const caps = getStorageCapabilities(
      providerWith({ privateObjects: true, signedUrls: true, download: true })
    );

    expect(caps).toEqual({ privateObjects: true, signedUrls: true, download: true });
  });

  it('does not mutate the shared default object', () => {
    getStorageCapabilities(
      providerWith({ privateObjects: true, signedUrls: true, download: true })
    );

    expect(DEFAULT_STORAGE_CAPABILITIES).toEqual({
      privateObjects: false,
      signedUrls: false,
      download: false,
    });
  });
});
