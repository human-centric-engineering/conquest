/**
 * detail-data Tests
 *
 * Server-side data layer for the demo-client detail surface. Covers:
 * - getDemoClientDetailCached: success, !res.ok, body.success=false, fetch throws (→ null)
 * - getReassignTargets: filters to active clients excluding self; degrades to [] on failure
 *
 * @see lib/app/questionnaire/demo-clients/detail-data.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (hoisted so factories run before module imports) ───────────────────

const { mockServerFetch, mockParseApiResponse } = vi.hoisted(() => ({
  mockServerFetch: vi.fn(),
  mockParseApiResponse: vi.fn(),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: mockServerFetch,
  parseApiResponse: mockParseApiResponse,
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import type { DemoClientDetail, DemoClientView } from '@/lib/app/questionnaire/demo-clients';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';
import {
  getAttributableQuestionnaires,
  getDemoClientDetailCached,
  getReassignTargets,
} from '@/lib/app/questionnaire/demo-clients/detail-data';

// ─── Factories ────────────────────────────────────────────────────────────────

function makeDetail(over: Partial<DemoClientDetail> = {}): DemoClientDetail {
  return {
    id: 'client-1',
    slug: 'acme-bank',
    name: 'Acme Bank',
    description: null,
    isActive: true,
    ctaColor: null,
    accentColor: null,
    logoUrl: null,
    welcomeCopy: null,
    surfaceColor: null,
    ctaColorEnd: null,
    logoBackgroundColor: null,
    logoBackgroundEnabled: false,
    questionnaireCount: 0,
    questionnaires: [],
    ...over,
  } as DemoClientDetail;
}

function makeListClient(over: Partial<DemoClientView> = {}): DemoClientView {
  return { ...makeDetail(), ...over };
}

const okResponse = { ok: true };
const errorResponse = { ok: false };

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── getDemoClientDetailCached ────────────────────────────────────────────────

describe('getDemoClientDetailCached', () => {
  it('returns the parsed detail and targets the byId endpoint', async () => {
    const detail = makeDetail({ id: 'client-9', name: 'Northwind' });
    mockServerFetch.mockResolvedValueOnce(okResponse);
    mockParseApiResponse.mockResolvedValueOnce({ success: true, data: detail });

    const result = await getDemoClientDetailCached('client-9');

    expect(result).toMatchObject({ id: 'client-9', name: 'Northwind' });
    expect(mockServerFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/app/demo-clients/client-9')
    );
  });

  it('returns null and skips parse when the response is !ok', async () => {
    mockServerFetch.mockResolvedValueOnce(errorResponse);
    const result = await getDemoClientDetailCached('client-1');
    expect(result).toBeNull();
    expect(mockParseApiResponse).not.toHaveBeenCalled();
  });

  it('returns null when the body envelope reports success=false', async () => {
    mockServerFetch.mockResolvedValueOnce(okResponse);
    mockParseApiResponse.mockResolvedValueOnce({ success: false, error: { code: 'NOT_FOUND' } });
    expect(await getDemoClientDetailCached('client-1')).toBeNull();
  });

  it('returns null and logs when serverFetch throws', async () => {
    const err = new Error('Network failure');
    mockServerFetch.mockRejectedValueOnce(err);
    expect(await getDemoClientDetailCached('client-1')).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith('demo client detail: fetch failed', err);
  });
});

// ─── getReassignTargets ───────────────────────────────────────────────────────

describe('getReassignTargets', () => {
  it('returns active clients other than the current one, mapped to {id, slug, name}', async () => {
    mockServerFetch.mockResolvedValueOnce(okResponse);
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: [
        makeListClient({ id: 'current', slug: 'cur', name: 'Current', isActive: true }),
        makeListClient({ id: 'other-a', slug: 'a', name: 'Alpha', isActive: true }),
        makeListClient({ id: 'inactive', slug: 'inact', name: 'Retired', isActive: false }),
      ],
    });

    const targets = await getReassignTargets('current');

    // self excluded (id match) and inactive excluded → only Alpha survives
    expect(targets).toEqual([{ id: 'other-a', slug: 'a', name: 'Alpha' }]);
  });

  it('degrades to an empty list when the response is !ok', async () => {
    mockServerFetch.mockResolvedValueOnce(errorResponse);
    expect(await getReassignTargets('current')).toEqual([]);
  });

  it('degrades to an empty list when the body reports success=false', async () => {
    mockServerFetch.mockResolvedValueOnce(okResponse);
    mockParseApiResponse.mockResolvedValueOnce({ success: false, error: { code: 'INTERNAL' } });
    expect(await getReassignTargets('current')).toEqual([]);
  });

  it('degrades to an empty list and logs when serverFetch throws', async () => {
    const err = new Error('Timeout');
    mockServerFetch.mockRejectedValueOnce(err);
    expect(await getReassignTargets('current')).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'demo client detail: reassign targets fetch failed',
      err
    );
  });
});

// ─── getAttributableQuestionnaires ────────────────────────────────────────────

function makeListItem(over: Partial<QuestionnaireListItem> = {}): QuestionnaireListItem {
  return {
    id: 'q1',
    title: 'Onboarding',
    status: 'draft',
    versionCount: 1,
    latestVersion: null,
    sectionCount: 0,
    questionCount: 0,
    dataSlotCount: 0,
    demoClient: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

describe('getAttributableQuestionnaires', () => {
  it('returns only the generic (unattributed) questionnaires, mapped to {id, title, status}', async () => {
    mockServerFetch.mockResolvedValueOnce(okResponse);
    mockParseApiResponse.mockResolvedValueOnce({
      success: true,
      data: [
        makeListItem({ id: 'free-1', title: 'Free one', status: 'launched', demoClient: null }),
        makeListItem({
          id: 'taken',
          title: 'Taken',
          demoClient: { id: 'c2', slug: 'x', name: 'X' },
        }),
        makeListItem({ id: 'free-2', title: 'Free two', status: 'draft', demoClient: null }),
      ],
    });

    const result = await getAttributableQuestionnaires();

    // attributed one filtered out; generics kept and trimmed to the row shape
    expect(result).toEqual([
      { id: 'free-1', title: 'Free one', status: 'launched' },
      { id: 'free-2', title: 'Free two', status: 'draft' },
    ]);
    expect(mockServerFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/app/questionnaires')
    );
  });

  it('degrades to an empty list when the response is !ok', async () => {
    mockServerFetch.mockResolvedValueOnce(errorResponse);
    expect(await getAttributableQuestionnaires()).toEqual([]);
    expect(mockParseApiResponse).not.toHaveBeenCalled();
  });

  it('degrades to an empty list and logs when serverFetch throws', async () => {
    const err = new Error('Boom');
    mockServerFetch.mockRejectedValueOnce(err);
    expect(await getAttributableQuestionnaires()).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'demo client detail: attributable questionnaires fetch failed',
      err
    );
  });
});
