/**
 * Demo-client Branding tab — unit tests.
 *
 *  - notFound() when the cached detail is null
 *  - renders the DemoClientForm seeded with the fetched client
 *
 * @see app/admin/demo-clients/[id]/branding/page.tsx
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

vi.mock('@/components/admin/demo-clients/demo-client-form', () => ({
  DemoClientForm: (props: { client?: { id: string } }) => (
    <div data-testid="form" data-client-id={props.client?.id ?? ''} />
  ),
}));

import DemoClientBrandingTab from '@/app/admin/demo-clients/[id]/branding/page';

const ctx = { params: Promise.resolve({ id: 'client-1' }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DemoClientBrandingTab', () => {
  it('notFound()s when the cached detail is null', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue(null);
    await expect(DemoClientBrandingTab({ params: ctx.params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled();
  });

  it('renders the edit form seeded with the fetched client', async () => {
    detailDataMock.getDemoClientDetailCached.mockResolvedValue({
      id: 'client-7',
      name: 'Acme',
    } as DemoClientDetail);
    render(await DemoClientBrandingTab({ params: ctx.params }));
    expect(screen.getByTestId('form').dataset.clientId).toBe('client-7');
  });
});
