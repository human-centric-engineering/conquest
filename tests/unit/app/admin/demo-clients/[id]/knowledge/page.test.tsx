/**
 * Demo-client Knowledge tab — unit tests.
 *
 *  - notFound() when the cached detail is null
 *  - renders ClientKnowledgePanel scoped to the fetched client (id + name)
 *
 * @see app/admin/demo-clients/[id]/knowledge/page.tsx
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

vi.mock('@/components/admin/demo-clients/client-knowledge-panel', () => ({
  ClientKnowledgePanel: (props: { clientId: string; clientName: string }) => (
    <div data-testid="kb" data-client-id={props.clientId} data-client-name={props.clientName} />
  ),
}));

import DemoClientKnowledgeTab from '@/app/admin/demo-clients/[id]/knowledge/page';

const ctx = { params: Promise.resolve({ id: 'client-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DemoClientKnowledgeTab', () => {
  it('notFound()s when the cached detail is null', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(null);
    await expect(DemoClientKnowledgeTab({ params: ctx.params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();
  });

  it('scopes the knowledge panel to the fetched client', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue({
      id: 'client-3',
      name: 'Northwind',
    } as DemoClientDetail);
    render(await DemoClientKnowledgeTab({ params: ctx.params }));
    const kb = screen.getByTestId('kb');
    expect(kb.dataset.clientId).toBe('client-3');
    expect(kb.dataset.clientName).toBe('Northwind');
  });
});
