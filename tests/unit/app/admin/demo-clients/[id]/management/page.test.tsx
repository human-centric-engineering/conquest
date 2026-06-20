/**
 * Demo-client Management tab — unit tests.
 *
 *  - notFound() when the cached detail is null
 *  - wires ResetSessionsDialog + DemoClientActions with the client identity
 *  - swaps the delete copy based on whether questionnaires are still attributed
 *
 * @see app/admin/demo-clients/[id]/management/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { DemoClientDetail } from '@/lib/app/questionnaire/demo-clients';

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound: mockNotFound }));

const detailDataMock = vi.hoisted(() => ({
  getDemoClientDetailCached: vi.fn<() => Promise<DemoClientDetail | null>>(),
}));
vi.mock('@/lib/app/questionnaire/demo-clients/detail-data', () => detailDataMock);

vi.mock('@/components/admin/demo-clients/reset-sessions-dialog', () => ({
  ResetSessionsDialog: (props: { id: string; name: string; slug: string }) => (
    <div data-testid="reset" data-id={props.id} data-slug={props.slug} />
  ),
}));
vi.mock('@/components/admin/demo-clients/demo-client-actions', () => ({
  DemoClientActions: (props: { id: string; name: string; questionnaireCount: number }) => (
    <div data-testid="actions" data-id={props.id} data-count={props.questionnaireCount} />
  ),
}));

import DemoClientManagementTab from '@/app/admin/demo-clients/[id]/management/page';

function makeDetail(over: Partial<DemoClientDetail> = {}): DemoClientDetail {
  return {
    id: 'client-1',
    slug: 'acme',
    name: 'Acme',
    questionnaireCount: 0,
    questionnaires: [],
    ...over,
  } as DemoClientDetail;
}

const ctx = { params: Promise.resolve({ id: 'client-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DemoClientManagementTab', () => {
  it('notFound()s when the cached detail is null', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(null);
    await expect(DemoClientManagementTab({ params: ctx.params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();
  });

  it('wires both destructive actions with the client identity + count', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(
      makeDetail({ id: 'client-5', slug: 'northwind', questionnaireCount: 3 })
    );
    render(await DemoClientManagementTab({ params: ctx.params }));

    expect(screen.getByTestId('reset').dataset.id).toBe('client-5');
    expect(screen.getByTestId('reset').dataset.slug).toBe('northwind');
    expect(screen.getByTestId('actions').dataset.count).toBe('3');
  });

  it('shows the guarded delete copy while questionnaires remain attributed', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(
      makeDetail({ questionnaireCount: 1 })
    );
    render(await DemoClientManagementTab({ params: ctx.params }));
    expect(screen.getByText(/Still branding 1 questionnaire/i)).toBeInTheDocument();
  });

  it('shows the plain delete copy when nothing is attributed', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(
      makeDetail({ questionnaireCount: 0 })
    );
    render(await DemoClientManagementTab({ params: ctx.params }));
    expect(screen.getByText(/Permanently remove this demo client/i)).toBeInTheDocument();
  });
});
