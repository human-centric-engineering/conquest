/**
 * QuestionnaireSubNav Component Tests
 *
 * Horizontal tab bar for the questionnaire workspace. A 'use client' component
 * that consumes `usePathname()` to decide which tab is active and builds hrefs
 * via the real `workspaceTabHref` helper (not mocked — it's pure logic).
 *
 * Test Coverage:
 * - Renders a link for each tab in the supplied list
 * - Marks the matching tab as active (aria-current="page") when pathname matches
 * - No other tab carries aria-current when one is active
 * - Exact-match tab (Overview) is only active when pathname equals its href, not
 *   when pathname merely starts with it
 * - Prefix-match tab is active when pathname starts with its href
 * - Hidden tabs (not in the supplied list) are absent from the DOM
 * - Tab hrefs are constructed correctly for the given id / versionId
 *
 * @see components/admin/questionnaires/workspace/questionnaire-sub-nav.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── next/navigation mock ─────────────────────────────────────────────────────
// Capture via vi.hoisted so the return value can be overridden per-test.

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
  visibleWorkspaceTabs,
  workspaceTabHref,
  workspaceVersionBase,
} from '@/lib/app/questionnaire/workspace-nav';
import type { QuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const QID = 'qn-abc';
const VID = 'ver-xyz';

/** Flags that enable every tab. */
const allFlagsOn: QuestionnaireWorkspaceFlags = {
  master: true,
  dataSlots: true,
  designEval: true,
  liveSessions: true,
  adaptive: true,
  adaptiveDataSlots: true,
};

/** Flags that disable optional tabs (dataSlots and designEval hidden). */
const flagsAllOff: QuestionnaireWorkspaceFlags = {
  master: true,
  dataSlots: false,
  designEval: false,
  liveSessions: false,
  adaptive: false,
  adaptiveDataSlots: false,
};

function renderNav(pathname: string, flags = allFlagsOn) {
  mockUsePathname.mockReturnValue(pathname);
  const tabs = visibleWorkspaceTabs(flags);
  return render(<QuestionnaireSubNav questionnaireId={QID} versionId={VID} tabs={tabs} />);
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QuestionnaireSubNav', () => {
  describe('link rendering', () => {
    it('renders a link for every tab supplied', () => {
      // Arrange: use the Overview href so one tab is active (avoids no-active noise)
      const overviewHref = workspaceVersionBase(QID, VID);
      renderNav(overviewHref);

      const tabs = visibleWorkspaceTabs(allFlagsOn);

      // Assert: one link per tab — verifies the map produced the right count
      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(tabs.length);
    });

    it('renders each tab with the correct accessible label (tab.label)', () => {
      // Arrange
      const overviewHref = workspaceVersionBase(QID, VID);
      renderNav(overviewHref);

      // Assert: each visible tab label appears as link text
      const visibleTabs = visibleWorkspaceTabs(allFlagsOn);
      for (const tab of visibleTabs) {
        expect(screen.getByRole('link', { name: tab.label })).toBeInTheDocument();
      }
    });

    it('builds the correct href for each tab using the real workspaceTabHref helper', () => {
      // Arrange
      const overviewHref = workspaceVersionBase(QID, VID);
      renderNav(overviewHref);

      // Assert: each link's href matches the expected workspace URL produced by
      // the real helper — verifies the component wires up ids correctly
      const visibleTabs = visibleWorkspaceTabs(allFlagsOn);
      for (const tab of visibleTabs) {
        const expectedHref = workspaceTabHref(QID, VID, tab);
        const link = screen.getByRole('link', { name: tab.label });
        // next/link renders an <a> whose href is the absolute URL in happy-dom
        expect(link).toHaveAttribute('href', expectedHref);
      }
    });
  });

  describe('active tab (aria-current)', () => {
    it('marks the matching tab as aria-current="page" when pathname equals its href', () => {
      // Arrange: navigate to the Structure tab
      const structureTab = QUESTIONNAIRE_WORKSPACE_TABS.find((t) => t.id === 'structure')!;
      const structureHref = workspaceTabHref(QID, VID, structureTab);
      renderNav(structureHref);

      // Assert: the Structure link carries aria-current
      const structureLink = screen.getByRole('link', { name: 'Structure' });
      expect(structureLink).toHaveAttribute('aria-current', 'page');
    });

    it('does not set aria-current on any other tab when one tab is active', () => {
      // Arrange: navigate to the Invitations tab
      const invitationsTab = QUESTIONNAIRE_WORKSPACE_TABS.find((t) => t.id === 'invitations')!;
      const invitationsHref = workspaceTabHref(QID, VID, invitationsTab);
      renderNav(invitationsHref);

      // Assert: only the Invitations link is active; all others are not
      const allLinks = screen.getAllByRole('link');
      const activeLinks = allLinks.filter((l) => l.getAttribute('aria-current') === 'page');
      expect(activeLinks).toHaveLength(1);
      expect(activeLinks[0]).toHaveAttribute('href', invitationsHref);
    });

    it('marks the Overview tab active when pathname is exactly the version base', () => {
      // Arrange: Overview href is the bare version base (segment = '')
      const overviewHref = workspaceVersionBase(QID, VID);
      renderNav(overviewHref);

      // Assert
      const overviewLink = screen.getByRole('link', { name: 'Overview' });
      expect(overviewLink).toHaveAttribute('aria-current', 'page');
    });

    it('does NOT mark Overview active when pathname is a sub-path of the version base', () => {
      // Arrange: pathname = version_base/structure — Overview has exact=true so
      // it must not light up on sub-routes
      const subPath = `${workspaceVersionBase(QID, VID)}/structure`;
      renderNav(subPath);

      // Assert: Overview is not active
      const overviewLink = screen.getByRole('link', { name: 'Overview' });
      expect(overviewLink).not.toHaveAttribute('aria-current');
    });

    it('marks a prefix-match tab active when pathname starts with its href', () => {
      // Arrange: navigate to a deeper sub-path under analytics
      const analyticsTab = QUESTIONNAIRE_WORKSPACE_TABS.find((t) => t.id === 'analytics')!;
      const analyticsHref = workspaceTabHref(QID, VID, analyticsTab);
      const deepPath = `${analyticsHref}/some-chart`;
      renderNav(deepPath);

      // Assert: Analytics link is active via prefix match
      const analyticsLink = screen.getByRole('link', { name: 'Analytics' });
      expect(analyticsLink).toHaveAttribute('aria-current', 'page');
    });

    it('does not mark any tab active when pathname does not match any tab href', () => {
      // Arrange: completely unrelated path
      renderNav('/admin/questionnaires');

      // Assert: no link carries aria-current
      const allLinks = screen.getAllByRole('link');
      for (const link of allLinks) {
        expect(link).not.toHaveAttribute('aria-current');
      }
    });
  });

  describe('flag-driven tab visibility', () => {
    it('hides the Data Slots tab when the dataSlots flag is off', () => {
      // Arrange: use flags with dataSlots disabled
      const overviewHref = workspaceVersionBase(QID, VID);
      renderNav(overviewHref, flagsAllOff);

      // Assert: no "Data slots" link in the DOM
      expect(screen.queryByRole('link', { name: 'Data slots' })).not.toBeInTheDocument();
    });

    it('hides the Evaluations tab when the designEval flag is off', () => {
      // Arrange
      const overviewHref = workspaceVersionBase(QID, VID);
      renderNav(overviewHref, flagsAllOff);

      // Assert: no "Evaluations" link in the DOM
      expect(screen.queryByRole('link', { name: 'Evaluations' })).not.toBeInTheDocument();
    });

    it('shows the Data Slots and Evaluations tabs when their flags are on', () => {
      // Arrange: all flags enabled
      const overviewHref = workspaceVersionBase(QID, VID);
      renderNav(overviewHref, allFlagsOn);

      // Assert: both optional tabs are rendered
      expect(screen.getByRole('link', { name: 'Data slots' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Evaluations' })).toBeInTheDocument();
    });

    it('renders tabs that have no flag guard regardless of flag state', () => {
      // Tabs like Invitations, Structure, Analytics, Changes, Settings have no
      // flag field — they must always appear when the component is rendered.
      const overviewHref = workspaceVersionBase(QID, VID);
      renderNav(overviewHref, flagsAllOff);

      // Assert: always-present tabs are still rendered with flags off
      expect(screen.getByRole('link', { name: 'Structure' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Invitations' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Analytics' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Extraction log' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    });
  });

  describe('nav landmark', () => {
    it('renders a nav element with an accessible label', () => {
      // Arrange
      renderNav(workspaceVersionBase(QID, VID));

      // Assert: nav landmark is present with its aria-label
      expect(
        screen.getByRole('navigation', { name: /questionnaire sections/i })
      ).toBeInTheDocument();
    });
  });
});
