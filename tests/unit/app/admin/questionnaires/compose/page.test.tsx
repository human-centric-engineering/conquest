/**
 * Compose Questionnaire page — render tests.
 *
 * The page is a thin server-component shell that renders the heading, back link,
 * FieldHelp, and `<ComposeStudio>`.
 *
 * Heavy children (ComposeStudio, FieldHelp) are stubbed so this stays a focused
 * render test.
 *
 * @see app/admin/questionnaires/compose/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// --- mocks must be declared before the dynamic import -------------------------

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

// Stub ComposeStudio — it's a 'use client' component with hooks, router, fetch.
// We only care whether the page renders it when both flags are on.
vi.mock('@/components/admin/questionnaires/compose/compose-studio', () => ({
  ComposeStudio: () => <div data-testid="compose-studio" />,
}));

// Stub FieldHelp — renders a tooltip shell in production; irrelevant here.
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

// next/link renders a plain <a> in tests — no stub needed.

// --- imports after mocks -------------------------------------------------------

import ComposeQuestionnairePage from '@/app/admin/questionnaires/compose/page';
import { notFound } from 'next/navigation';
import type React from 'react';

// ------------------------------------------------------------------------------

describe('ComposeQuestionnairePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders ComposeStudio and does NOT call notFound', async () => {
    render(ComposeQuestionnairePage());

    // The page's own logic: ComposeStudio must be mounted.
    expect(screen.getByTestId('compose-studio')).toBeInTheDocument();

    // notFound must NOT have been called — the page rendered normally.
    expect(notFound).not.toHaveBeenCalled();
  });

  it('renders the page heading', async () => {
    render(ComposeQuestionnairePage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/compose a questionnaire/i);
  });

  it('renders a back-link to /admin/questionnaires', async () => {
    render(ComposeQuestionnairePage());

    const link = screen.getByRole('link', { name: /questionnaires/i });
    expect(link).toHaveAttribute('href', '/admin/questionnaires');
  });
});
