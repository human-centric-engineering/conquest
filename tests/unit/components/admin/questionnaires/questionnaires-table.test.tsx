/**
 * QuestionnairesTable empty-state tests.
 *
 * Scope: the F-gap upload affordance. Asserts that with no questionnaires the
 * table renders the friendly empty-state copy plus the `UploadQuestionnaireDialog`
 * CTA (not the old "POST the API by hand" message), and that with rows present the
 * empty-state CTA is gone. The table hydrates from `initialItems`, so these render
 * without any network fetch.
 *
 * @see components/admin/questionnaires/questionnaires-table.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import { QuestionnairesTable } from '@/components/admin/questionnaires/questionnaires-table';
import type { QuestionnaireListItem } from '@/lib/app/questionnaire/views';
import type { PaginationMeta } from '@/types/api';

const META: PaginationMeta = { page: 1, limit: 25, total: 0, totalPages: 1 };

function item(over: Partial<QuestionnaireListItem> = {}): QuestionnaireListItem {
  // No `as` cast — let TypeScript enforce the real QuestionnaireListItem shape so
  // the fixture can't drift from the fields the component actually reads (notably
  // `updatedAt`, which the row renders via formatDate).
  return {
    id: 'qn-1',
    title: 'Onboarding survey',
    status: 'draft',
    versionCount: 1,
    latestVersion: { id: 'v-1', versionNumber: 1, status: 'draft' },
    sectionCount: 2,
    questionCount: 9,
    demoClient: null,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    ...over,
  };
}

describe('QuestionnairesTable empty state', () => {
  it('shows the upload CTA and friendly copy when there are no questionnaires', () => {
    render(<QuestionnairesTable initialItems={[]} initialMeta={META} />);

    expect(screen.getByText(/no questionnaires yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload questionnaire/i })).toBeInTheDocument();
    // The old "call the API by hand" guidance must be gone.
    expect(screen.queryByText(/POST \/api\/v1\/app\/questionnaires/i)).not.toBeInTheDocument();
  });

  it('renders rows and no empty-state CTA when questionnaires exist', () => {
    render(<QuestionnairesTable initialItems={[item()]} initialMeta={{ ...META, total: 1 }} />);

    expect(screen.getByText('Onboarding survey')).toBeInTheDocument();
    // Each enriched column actually renders, so a dropped/corrupted field fails here.
    expect(screen.getByText('Draft')).toBeInTheDocument(); // status badge label
    expect(screen.getByText('v1')).toBeInTheDocument(); // latest version number
    expect(screen.getByText('2')).toBeInTheDocument(); // section count
    expect(screen.getByText('9')).toBeInTheDocument(); // question count
    // Locks the formatDate(updatedAt) regression: a missing/renamed date field
    // would render "Invalid Date" here (locale/TZ-independent check).
    expect(screen.queryByText(/invalid date/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no questionnaires yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload questionnaire/i })).not.toBeInTheDocument();
  });
});

describe('QuestionnairesTable demo-client column', () => {
  it('renders the attributed demo client name in its own row', () => {
    render(
      <QuestionnairesTable
        initialItems={[
          item({ demoClient: { id: 'client-1', slug: 'acme-bank', name: 'Acme Bank' } }),
        ]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    expect(screen.getByRole('columnheader', { name: /demo client/i })).toBeInTheDocument();
    expect(screen.getByText('Acme Bank')).toBeInTheDocument();
  });

  it('shows an em-dash when a questionnaire has no demo client', () => {
    render(
      <QuestionnairesTable
        initialItems={[item({ demoClient: null })]}
        initialMeta={{ ...META, total: 1 }}
      />
    );

    // The owner cell falls back to a muted em-dash rather than rendering blank.
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
