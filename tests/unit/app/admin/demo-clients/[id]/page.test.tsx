/**
 * Demo-client Overview tab — unit tests.
 *
 *  - notFound() when the cached detail is null
 *  - renders the attributed list + reassign targets when questionnaires exist
 *  - skips the reassign-target fetch and shows an empty state when none are attributed
 *  - forwards the saved theme to the brand preview
 *
 * @see app/admin/demo-clients/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { DemoClientDetail, AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));

const detailDataMock = vi.hoisted(() => ({
  getDemoClientDetailCached: vi.fn<() => Promise<DemoClientDetail | null>>(),
  getReassignTargets: vi.fn<() => Promise<AttributedDemoClient[]>>(),
  getAttributableQuestionnaires: vi.fn<() => Promise<unknown[]>>(),
}));
vi.mock('@/lib/app/questionnaire/demo-clients/detail-data', () => detailDataMock);

vi.mock('@/components/admin/demo-clients/attributed-questionnaires', () => ({
  AttributedQuestionnaires: (props: { questionnaires: unknown[]; reassignTargets: unknown[] }) => (
    <div
      data-testid="attributed"
      data-count={props.questionnaires.length}
      data-targets={props.reassignTargets.length}
    />
  ),
}));
vi.mock('@/components/admin/demo-clients/attribute-questionnaire-picker', () => ({
  AttributeQuestionnairePicker: (props: { clientId: string; options: unknown[] }) => (
    <div data-testid="picker" data-client={props.clientId} data-options={props.options.length} />
  ),
}));
vi.mock('@/components/admin/demo-clients/demo-client-theme-preview', () => ({
  // Capture a real DemoClientTheme field (ctaColor) so the assertion proves the saved
  // brand — not an incidental id — is the object forwarded to the preview.
  DemoClientThemePreview: (props: { theme: { ctaColor?: string | null } }) => (
    <div data-testid="preview" data-cta={props.theme?.ctaColor ?? ''} />
  ),
}));

import DemoClientOverviewTab from '@/app/admin/demo-clients/[id]/page';

function makeDetail(over: Partial<DemoClientDetail> = {}): DemoClientDetail {
  return {
    id: 'client-1',
    slug: 'acme',
    name: 'Acme',
    description: null,
    isActive: true,
    ctaColor: '#5469d4',
    questionnaireCount: 0,
    questionnaires: [],
    ...over,
  } as DemoClientDetail;
}

const ctx = { params: Promise.resolve({ id: 'client-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  detailDataMock.getReassignTargets.mockResolvedValue([]);
  detailDataMock.getAttributableQuestionnaires.mockResolvedValue([]);
});

describe('DemoClientOverviewTab', () => {
  it('notFound()s when the cached detail is null', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(null);
    await expect(DemoClientOverviewTab({ params: ctx.params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();
  });

  it('renders the attributed list with fetched reassign targets when questionnaires exist', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(
      makeDetail({
        questionnaireCount: 2,
        questionnaires: [{ id: 'q1' }, { id: 'q2' }] as DemoClientDetail['questionnaires'],
      })
    );
    detailDataMock.getReassignTargets.mockResolvedValue([
      { id: 'c2', slug: 'other', name: 'Other' },
    ]);

    render(await DemoClientOverviewTab({ params: ctx.params }));

    const attributed = screen.getByTestId('attributed');
    expect(attributed.dataset.count).toBe('2');
    expect(attributed.dataset.targets).toBe('1');
    expect(detailDataMock.getReassignTargets).toHaveBeenCalledWith('client-1');
  });

  it('shows an empty state and skips the reassign fetch when nothing is attributed', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(makeDetail());

    render(await DemoClientOverviewTab({ params: ctx.params }));

    expect(screen.queryByTestId('attributed')).not.toBeInTheDocument();
    expect(
      screen.getByText(/No questionnaires are branded as this client yet/i)
    ).toBeInTheDocument();
    expect(detailDataMock.getReassignTargets).not.toHaveBeenCalled();
  });

  it('renders the attribute picker with the available (generic) questionnaires', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(makeDetail());
    detailDataMock.getAttributableQuestionnaires.mockResolvedValue([
      { id: 'q9', title: 'Spare', status: 'draft' },
    ]);

    render(await DemoClientOverviewTab({ params: ctx.params }));

    const picker = screen.getByTestId('picker');
    expect(picker.dataset.client).toBe('client-1');
    expect(picker.dataset.options).toBe('1');
    expect(detailDataMock.getAttributableQuestionnaires).toHaveBeenCalled();
  });

  it('forwards the saved client theme to the brand preview', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(makeDetail({ ctaColor: '#280039' }));
    render(await DemoClientOverviewTab({ params: ctx.params }));
    expect(screen.getByTestId('preview').dataset.cta).toBe('#280039');
  });
});
