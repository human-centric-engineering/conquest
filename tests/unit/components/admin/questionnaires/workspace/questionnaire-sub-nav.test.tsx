/**
 * QuestionnaireSubNav Component Tests
 *
 * Two-tier lifecycle tab bar for the questionnaire workspace. A 'use client'
 * component that consumes `usePathname()` to decide which group/tab is active and
 * builds hrefs via the real `workspaceTabHref` helper (not mocked — pure logic).
 *
 * Test Coverage:
 * - Top tier renders one link per lifecycle group (Overview · Build · Distribute ·
 *   Results · Settings)
 * - The group link points at its first child tab
 * - The second tier appears only for the ACTIVE group, and only when it has >1 tab
 * - Children of non-active groups are absent from the DOM
 * - Active-state (aria-current) tracks both the active group and its active child
 * - Exact-match Overview group is active only on the version base, not sub-routes
 * - Lifecycle dimming: a draft de-emphasizes Distribute + Results; launched dims none
 *
 * @see components/admin/questionnaires/workspace/questionnaire-sub-nav.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── next/navigation mock ─────────────────────────────────────────────────────

const { mockUsePathname } = vi.hoisted(() => ({
  mockUsePathname: vi.fn<() => string>(),
}));

vi.mock('next/navigation', () => ({
  usePathname: mockUsePathname,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { QuestionnaireSubNav } from '@/components/admin/questionnaires/workspace/questionnaire-sub-nav';
import {
  QUESTIONNAIRE_WORKSPACE_TABS,
  visibleWorkspaceGroups,
  workspaceTabHref,
  workspaceVersionBase,
} from '@/lib/app/questionnaire/workspace-nav';
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const QID = 'qn-abc';
const VID = 'ver-xyz';
const GROUP_LABELS = ['Overview', 'Build', 'Distribute', 'Results', 'Settings'];

const tabHref = (id: string) =>
  workspaceTabHref(
    QID,
    VID,
    QUESTIONNAIRE_WORKSPACE_TABS.find((t) => t.id === id)!
  );

function renderNav(pathname: string, opts: { status?: AppQuestionnaireStatus } = {}) {
  mockUsePathname.mockReturnValue(pathname);
  const groups = visibleWorkspaceGroups();
  return render(
    <QuestionnaireSubNav
      questionnaireId={QID}
      versionId={VID}
      groups={groups}
      status={opts.status ?? 'launched'}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QuestionnaireSubNav', () => {
  describe('top tier (lifecycle groups)', () => {
    it('renders one link per lifecycle group', () => {
      renderNav(workspaceVersionBase(QID, VID));
      for (const label of GROUP_LABELS) {
        expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
      }
    });

    it('points each group link at its first child tab', () => {
      renderNav(workspaceVersionBase(QID, VID));
      // Build's first child is Structure; Results' first child is Analytics.
      expect(screen.getByRole('link', { name: 'Build' })).toHaveAttribute(
        'href',
        tabHref('structure')
      );
      expect(screen.getByRole('link', { name: 'Results' })).toHaveAttribute(
        'href',
        tabHref('analytics')
      );
      expect(screen.getByRole('link', { name: 'Distribute' })).toHaveAttribute(
        'href',
        tabHref('invitations')
      );
    });
  });

  describe('second tier (active group children)', () => {
    it('does NOT render a second tier for a single-tab group (Overview)', () => {
      renderNav(workspaceVersionBase(QID, VID));
      // Overview is the active group but has only itself → no child row, so no
      // Build/Distribute children leak into the DOM.
      expect(screen.queryByRole('link', { name: 'Structure' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Invitations' })).not.toBeInTheDocument();
    });

    it("renders the active group's children when it has more than one tab", () => {
      renderNav(tabHref('structure'));
      // Build is active → its children appear in the second tier.
      for (const label of ['Structure', 'Data slots', 'Evaluations', 'Extraction log']) {
        expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
      }
    });

    it('does not render children of non-active groups', () => {
      renderNav(tabHref('structure'));
      // Distribute / Results children must be absent while Build is active.
      expect(screen.queryByRole('link', { name: 'Invitations' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Analytics' })).not.toBeInTheDocument();
    });
  });

  describe('active state (aria-current)', () => {
    it('marks the Overview group active on the exact version base', () => {
      renderNav(workspaceVersionBase(QID, VID));
      expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
        'aria-current',
        'page'
      );
    });

    it('does NOT mark Overview active on a sub-route (exact match)', () => {
      renderNav(tabHref('structure'));
      expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    });

    it('marks both the active group and its active child', () => {
      renderNav(tabHref('structure'));
      expect(screen.getByRole('link', { name: 'Build' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: 'Structure' })).toHaveAttribute(
        'aria-current',
        'page'
      );
    });

    it('resolves the active group by prefix match on a deep sub-path', () => {
      renderNav(`${tabHref('analytics')}/some-chart`);
      expect(screen.getByRole('link', { name: 'Results' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
        'aria-current',
        'page'
      );
    });
  });

  describe('lifecycle dimming', () => {
    it('dims Distribute + Results on a draft', () => {
      renderNav(workspaceVersionBase(QID, VID), { status: 'draft' });
      expect(screen.getByRole('link', { name: 'Distribute' })).toHaveClass('opacity-50');
      expect(screen.getByRole('link', { name: 'Results' })).toHaveClass('opacity-50');
      // Build / Overview / Settings are never dimmed.
      expect(screen.getByRole('link', { name: 'Build' })).not.toHaveClass('opacity-50');
    });

    it('exposes a tooltip on a dimmed group explaining why', () => {
      renderNav(workspaceVersionBase(QID, VID), { status: 'draft' });
      // Assert the exact copy — a presence-only check passes on a typo'd or wrong hint.
      expect(screen.getByRole('link', { name: 'Distribute' })).toHaveAttribute(
        'title',
        'Available once the questionnaire is launched'
      );
    });

    it('dims nothing on a launched questionnaire', () => {
      renderNav(workspaceVersionBase(QID, VID), { status: 'launched' });
      expect(screen.getByRole('link', { name: 'Distribute' })).not.toHaveClass('opacity-50');
      expect(screen.getByRole('link', { name: 'Results' })).not.toHaveClass('opacity-50');
    });

    it('uses an archive-specific tooltip on an archived questionnaire', () => {
      renderNav(workspaceVersionBase(QID, VID), { status: 'archived' });
      const distribute = screen.getByRole('link', { name: 'Distribute' });
      expect(distribute).toHaveClass('opacity-50');
      // Archived was already launched — the draft "launch first" copy would be wrong.
      expect(distribute).toHaveAttribute(
        'title',
        'This questionnaire is archived — no new respondents can be invited'
      );
    });
  });

  describe('nav landmark', () => {
    it('renders a nav element with an accessible label', () => {
      renderNav(workspaceVersionBase(QID, VID));
      expect(
        screen.getByRole('navigation', { name: /questionnaire sections/i })
      ).toBeInTheDocument();
    });
  });
});
