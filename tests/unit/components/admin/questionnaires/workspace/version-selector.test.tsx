/**
 * VersionSelector Component Tests
 *
 * Version switcher for the questionnaire workspace header. Switching version
 * preserves the active tab segment while dropping any deeper sub-path. Uses
 * `next/navigation` (useRouter, usePathname) for navigation.
 *
 * Test Coverage:
 * - With a single version: renders a plain text span, not a Select, with the
 *   version number and status
 * - With a single version where `versions` is empty: renders nothing
 * - With multiple versions: renders a Select trigger labelled "Select version"
 * - Current versionId is reflected as the selected value in the Select
 * - Switching to a different version navigates to the version base path when on
 *   the version base (no tab segment to preserve)
 * - Switching version preserves the top-level tab segment (e.g. /structure)
 *   and drops any deeper sub-path
 * - Selecting the already-active version does not trigger navigation
 *
 * The `workspaceVersionBase` helper is NOT mocked — the tests exercise the real
 * URL construction logic to verify the component wires the pieces correctly.
 *
 * @see components/admin/questionnaires/workspace/version-selector.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── next/navigation mock ─────────────────────────────────────────────────────

const { mockRouterPush, mockUsePathname } = vi.hoisted(() => ({
  mockRouterPush: vi.fn<(url: string) => void>(),
  mockUsePathname: vi.fn<() => string>(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: mockUsePathname,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { VersionSelector } from '@/components/admin/questionnaires/workspace/version-selector';
import type { VersionOption } from '@/components/admin/questionnaires/workspace/version-selector';
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const QID = 'qn-abc';
const VID_1 = 'ver-1';
const VID_2 = 'ver-2';
const VID_3 = 'ver-3';

function makeVersion(over: Partial<VersionOption> & Pick<VersionOption, 'id'>): VersionOption {
  return {
    versionNumber: 1,
    status: 'draft',
    ...over,
  };
}

function renderSelector(opts: {
  versionId?: string;
  versions?: readonly VersionOption[];
  pathname?: string;
}) {
  const versionId = opts.versionId ?? VID_1;
  const versions = opts.versions ?? [
    makeVersion({ id: VID_1, versionNumber: 1, status: 'draft' }),
    makeVersion({ id: VID_2, versionNumber: 2, status: 'launched' }),
  ];
  const pathname = opts.pathname ?? workspaceVersionBase(QID, versionId);
  mockUsePathname.mockReturnValue(pathname);

  return render(
    <VersionSelector questionnaireId={QID} versionId={versionId} versions={versions} />
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VersionSelector', () => {
  describe('single-version display (no switcher)', () => {
    it('renders a plain text span with version number and status when only one version exists', () => {
      // Arrange
      mockUsePathname.mockReturnValue(workspaceVersionBase(QID, VID_1));

      // Act
      render(
        <VersionSelector
          questionnaireId={QID}
          versionId={VID_1}
          versions={[makeVersion({ id: VID_1, versionNumber: 3, status: 'launched' })]}
        />
      );

      // Assert: span text includes the version number and status
      expect(screen.getByText('v3 · launched')).toBeInTheDocument();
      // The Select trigger is NOT rendered for a single version
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('renders nothing when versions is empty', () => {
      // Arrange
      mockUsePathname.mockReturnValue(workspaceVersionBase(QID, VID_1));

      // Act
      const { container } = render(
        <VersionSelector questionnaireId={QID} versionId={VID_1} versions={[]} />
      );

      // Assert: component returns null — nothing was mounted
      expect(container.firstChild).toBeNull();
    });
  });

  describe('multi-version Select rendering', () => {
    it('renders a Select combobox (trigger) when multiple versions exist', () => {
      // Arrange + Act
      renderSelector({});

      // Assert: the Select trigger is present
      expect(screen.getByRole('combobox', { name: /select version/i })).toBeInTheDocument();
    });

    it('displays the current version as the selected value', () => {
      // Arrange: set VID_2 as the active version
      const pathname = workspaceVersionBase(QID, VID_2);
      mockUsePathname.mockReturnValue(pathname);

      // Act
      render(
        <VersionSelector
          questionnaireId={QID}
          versionId={VID_2}
          versions={[
            makeVersion({ id: VID_1, versionNumber: 1, status: 'draft' }),
            makeVersion({ id: VID_2, versionNumber: 2, status: 'launched' }),
          ]}
        />
      );

      // Assert: the trigger shows the selected version label
      // (Radix SelectValue renders the currently selected item text in the trigger)
      const trigger = screen.getByRole('combobox', { name: /select version/i });
      expect(trigger).toHaveTextContent('v2 · launched');
    });
  });

  describe('version switch navigation', () => {
    it('navigates to the new version base path when switching from the version base', async () => {
      // Arrange: current pathname is the bare version base (no tab segment)
      const user = userEvent.setup();
      const pathname = workspaceVersionBase(QID, VID_1);
      mockUsePathname.mockReturnValue(pathname);

      render(
        <VersionSelector
          questionnaireId={QID}
          versionId={VID_1}
          versions={[
            makeVersion({ id: VID_1, versionNumber: 1, status: 'draft' }),
            makeVersion({ id: VID_2, versionNumber: 2, status: 'launched' }),
          ]}
        />
      );

      // Act: open the Select and pick the second version
      await user.click(screen.getByRole('combobox', { name: /select version/i }));
      await user.click(screen.getByRole('option', { name: /v2/i }));

      // Assert: router.push called with the new version's base path (no tab segment)
      const expectedPath = workspaceVersionBase(QID, VID_2);
      expect(mockRouterPush).toHaveBeenCalledWith(expectedPath);
      expect(mockRouterPush).toHaveBeenCalledTimes(1);
    });

    it('preserves the top-level tab segment when switching versions', async () => {
      // Arrange: currently on the Structure tab of version 1
      const user = userEvent.setup();
      const currentBase = workspaceVersionBase(QID, VID_1);
      const pathname = `${currentBase}/structure`;
      mockUsePathname.mockReturnValue(pathname);

      render(
        <VersionSelector
          questionnaireId={QID}
          versionId={VID_1}
          versions={[
            makeVersion({ id: VID_1, versionNumber: 1, status: 'draft' }),
            makeVersion({ id: VID_2, versionNumber: 2, status: 'launched' }),
          ]}
        />
      );

      // Act: switch to version 2
      await user.click(screen.getByRole('combobox', { name: /select version/i }));
      await user.click(screen.getByRole('option', { name: /v2/i }));

      // Assert: router.push called with the /structure segment preserved
      const expectedPath = `${workspaceVersionBase(QID, VID_2)}/structure`;
      expect(mockRouterPush).toHaveBeenCalledWith(expectedPath);
    });

    it('drops deeper sub-path segments when switching version, keeping only the top segment', async () => {
      // Arrange: currently viewing a specific evaluation run under evaluations
      const user = userEvent.setup();
      const currentBase = workspaceVersionBase(QID, VID_1);
      const pathname = `${currentBase}/evaluations/run-abc-123`;
      mockUsePathname.mockReturnValue(pathname);

      render(
        <VersionSelector
          questionnaireId={QID}
          versionId={VID_1}
          versions={[
            makeVersion({ id: VID_1, versionNumber: 1, status: 'draft' }),
            makeVersion({ id: VID_2, versionNumber: 2, status: 'launched' }),
          ]}
        />
      );

      // Act: switch to version 2
      await user.click(screen.getByRole('combobox', { name: /select version/i }));
      await user.click(screen.getByRole('option', { name: /v2/i }));

      // Assert: only /evaluations is preserved — /run-abc-123 is dropped
      const expectedPath = `${workspaceVersionBase(QID, VID_2)}/evaluations`;
      expect(mockRouterPush).toHaveBeenCalledWith(expectedPath);
    });

    it('does not call router.push when the selected version is already the current version', async () => {
      // Arrange
      const user = userEvent.setup();
      const pathname = workspaceVersionBase(QID, VID_1);
      mockUsePathname.mockReturnValue(pathname);

      render(
        <VersionSelector
          questionnaireId={QID}
          versionId={VID_1}
          versions={[
            makeVersion({ id: VID_1, versionNumber: 1, status: 'draft' }),
            makeVersion({ id: VID_2, versionNumber: 2, status: 'launched' }),
          ]}
        />
      );

      // Act: open and re-select the already-active version
      await user.click(screen.getByRole('combobox', { name: /select version/i }));
      await user.click(screen.getByRole('option', { name: /v1/i }));

      // Assert: no navigation occurred — component short-circuits when nextVersionId === versionId
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it('navigates to the correct base path for a three-version selector', async () => {
      // Arrange
      const user = userEvent.setup();
      const pathname = workspaceVersionBase(QID, VID_1);
      mockUsePathname.mockReturnValue(pathname);

      render(
        <VersionSelector
          questionnaireId={QID}
          versionId={VID_1}
          versions={[
            makeVersion({ id: VID_1, versionNumber: 1, status: 'draft' }),
            makeVersion({ id: VID_2, versionNumber: 2, status: 'launched' }),
            makeVersion({ id: VID_3, versionNumber: 3, status: 'archived' }),
          ]}
        />
      );

      // Act: switch directly to version 3
      await user.click(screen.getByRole('combobox', { name: /select version/i }));
      await user.click(screen.getByRole('option', { name: /v3/i }));

      // Assert: navigates to the version 3 base
      expect(mockRouterPush).toHaveBeenCalledWith(workspaceVersionBase(QID, VID_3));
    });
  });
});
