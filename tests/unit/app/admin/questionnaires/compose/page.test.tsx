/**
 * Compose Questionnaire page — feature-flag gate tests.
 *
 * The page is a thin async server-component shell. Its only logic is:
 *   1. Call `isQuestionnairesEnabled()` and `isGenerativeAuthoringEnabled()`.
 *   2. If EITHER is falsy → call `notFound()`.
 *   3. Otherwise render the heading, back link, FieldHelp, and `<ComposeStudio>`.
 *
 * Heavy children (ComposeStudio, FieldHelp) are stubbed so this stays a pure
 * flag-gate test. The `notFound` mock throws so the page aborts — the same
 * contract the sibling list-page test uses.
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

vi.mock('@/lib/app/questionnaire/feature-flag', () => ({
  isQuestionnairesEnabled: vi.fn(),
  isGenerativeAuthoringEnabled: vi.fn(),
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
import {
  isQuestionnairesEnabled,
  isGenerativeAuthoringEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { notFound } from 'next/navigation';
import type React from 'react';

// ------------------------------------------------------------------------------

describe('ComposeQuestionnairePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls notFound when the master questionnaires flag is off', async () => {
    vi.mocked(isQuestionnairesEnabled).mockResolvedValue(false);
    vi.mocked(isGenerativeAuthoringEnabled).mockResolvedValue(false);

    // notFound() throws 'NEXT_NOT_FOUND' (see mock above) so the page aborts.
    await expect(ComposeQuestionnairePage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('calls notFound when master flag is on but generative-authoring sub-flag is off', async () => {
    vi.mocked(isQuestionnairesEnabled).mockResolvedValue(true);
    vi.mocked(isGenerativeAuthoringEnabled).mockResolvedValue(false);

    await expect(ComposeQuestionnairePage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('renders ComposeStudio and does NOT call notFound when both flags are on', async () => {
    vi.mocked(isQuestionnairesEnabled).mockResolvedValue(true);
    vi.mocked(isGenerativeAuthoringEnabled).mockResolvedValue(true);

    render(await ComposeQuestionnairePage());

    // The page's own logic: ComposeStudio must be mounted.
    expect(screen.getByTestId('compose-studio')).toBeInTheDocument();

    // notFound must NOT have been called — the page rendered normally.
    expect(notFound).not.toHaveBeenCalled();
  });

  it('renders the page heading when both flags are on', async () => {
    vi.mocked(isQuestionnairesEnabled).mockResolvedValue(true);
    vi.mocked(isGenerativeAuthoringEnabled).mockResolvedValue(true);

    render(await ComposeQuestionnairePage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/compose a questionnaire/i);
  });

  it('renders a back-link to /admin/questionnaires when both flags are on', async () => {
    vi.mocked(isQuestionnairesEnabled).mockResolvedValue(true);
    vi.mocked(isGenerativeAuthoringEnabled).mockResolvedValue(true);

    render(await ComposeQuestionnairePage());

    const link = screen.getByRole('link', { name: /questionnaires/i });
    expect(link).toHaveAttribute('href', '/admin/questionnaires');
  });
});
