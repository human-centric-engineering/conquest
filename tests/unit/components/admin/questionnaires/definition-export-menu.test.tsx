/**
 * DefinitionExportMenu Component Tests
 *
 * Tests the "Export / download" dropdown on the Structure tab (F14.9).
 * Verifies trigger state, download link URLs/attributes, dialog open behaviour,
 * duplicate action, and error rendering.
 *
 * Test Coverage:
 * - Trigger button renders with correct label
 * - Trigger is disabled with a spinner when isDuplicating is true
 * - Export-definition link has correct href and download attribute
 * - Three instrument download links (pdf/text/csv) with correct query strings
 * - "Import definition (JSON)" item opens the ImportDefinitionDialog
 * - "Duplicate this questionnaire" calls the hook's duplicate(questionnaireId)
 * - Error string from the hook renders when present
 *
 * @see components/admin/questionnaires/definition-export-menu.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Hoisted mock factories ───────────────────────────────────────────────────

const mockUseDuplicate = vi.hoisted(() => vi.fn());

// ─── Module mocks ─────────────────────────────────────────────────────────────

/**
 * Control `duplicate`, `isDuplicating`, and `error` per-test via
 * `mockUseDuplicate.mockReturnValue(...)` in beforeEach / individual tests.
 */
vi.mock('@/components/admin/questionnaires/use-duplicate-questionnaire', () => ({
  useDuplicateQuestionnaire: mockUseDuplicate,
}));

/**
 * Stub the dialog to a marker element so we can assert on its `open` prop
 * without rendering the full dialog tree.
 */
vi.mock('@/components/admin/questionnaires/import-definition-dialog', () => ({
  ImportDefinitionDialog: ({ open }: { open: boolean }) => (
    <div data-testid="import-dialog" data-open={String(open)} />
  ),
}));

// ─── Component import (after mocks) ──────────────────────────────────────────

import { DefinitionExportMenu } from '@/components/admin/questionnaires/definition-export-menu';

// ─── Constants ────────────────────────────────────────────────────────────────

const QID = 'q-abc';
const VID = 'v-xyz';
const BASE_DEFINITION_URL = `/api/v1/app/questionnaires/${QID}/versions/${VID}/definition`;
const BASE_INSTRUMENT_URL = `/api/v1/app/questionnaires/${QID}/versions/${VID}/instrument`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderMenu(props?: Partial<{ questionnaireId: string; versionId: string }>) {
  return render(
    <DefinitionExportMenu
      questionnaireId={props?.questionnaireId ?? QID}
      versionId={props?.versionId ?? VID}
    />
  );
}

async function openDropdown(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole('button', { name: /export \/ download/i });
  await user.click(trigger);
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('DefinitionExportMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: idle state, no error.
    mockUseDuplicate.mockReturnValue({
      duplicate: vi.fn().mockResolvedValue(null),
      isDuplicating: false,
      error: null,
      clearError: vi.fn(),
    });
  });

  // ── Trigger button ─────────────────────────────────────────────────────────

  describe('trigger button', () => {
    it('renders with "Export / download" label', () => {
      // Arrange & Act
      renderMenu();

      // Assert: the button is visible
      expect(screen.getByRole('button', { name: /export \/ download/i })).toBeInTheDocument();
    });

    it('is enabled when not duplicating', () => {
      // Arrange: default isDuplicating = false
      renderMenu();

      // Assert: button can be interacted with
      expect(screen.getByRole('button', { name: /export \/ download/i })).not.toBeDisabled();
    });

    it('is disabled when isDuplicating is true', () => {
      // Arrange: hook reports an in-flight duplicate operation
      mockUseDuplicate.mockReturnValue({
        duplicate: vi.fn(),
        isDuplicating: true,
        error: null,
        clearError: vi.fn(),
      });

      // Act
      renderMenu();

      // Assert: button is disabled so the user cannot trigger a second operation
      expect(screen.getByRole('button', { name: /export \/ download/i })).toBeDisabled();
    });

    it('shows a spinning svg (Loader2) when isDuplicating is true', () => {
      // Arrange
      mockUseDuplicate.mockReturnValue({
        duplicate: vi.fn(),
        isDuplicating: true,
        error: null,
        clearError: vi.fn(),
      });

      // Act
      renderMenu();

      // Assert: the trigger button contains an SVG with animate-spin — the code
      // conditionally renders Loader2 (with animate-spin) instead of Download.
      const button = screen.getByRole('button', { name: /export \/ download/i });
      const spinner = button.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });
  });

  // ── Download links ─────────────────────────────────────────────────────────

  describe('export definition link', () => {
    it('points at versionDefinition URL and carries the download attribute', async () => {
      // Arrange
      const user = userEvent.setup();
      renderMenu();

      // Act: open the dropdown
      await openDropdown(user);

      // Assert: the "Export definition (JSON)" anchor has the right href and download attribute
      await waitFor(() => {
        const link = screen.getByRole('menuitem', { name: /export definition \(json\)/i });
        expect(link.closest('a')).toHaveAttribute('href', BASE_DEFINITION_URL);
        expect(link.closest('a')).toHaveAttribute('download');
      });
    });
  });

  describe('instrument download links', () => {
    it('PDF link points at versionInstrument with format=pdf', async () => {
      // Arrange
      const user = userEvent.setup();
      renderMenu();
      await openDropdown(user);

      // Assert: correct href + download attribute
      await waitFor(() => {
        const link = screen.getByRole('menuitem', { name: /download instrument \(pdf\)/i });
        expect(link.closest('a')).toHaveAttribute('href', `${BASE_INSTRUMENT_URL}?format=pdf`);
        expect(link.closest('a')).toHaveAttribute('download');
      });
    });

    it('text link points at versionInstrument with format=text', async () => {
      // Arrange
      const user = userEvent.setup();
      renderMenu();
      await openDropdown(user);

      // Assert
      await waitFor(() => {
        const link = screen.getByRole('menuitem', { name: /download instrument \(text\)/i });
        expect(link.closest('a')).toHaveAttribute('href', `${BASE_INSTRUMENT_URL}?format=text`);
        expect(link.closest('a')).toHaveAttribute('download');
      });
    });

    it('CSV link points at versionInstrument with format=csv', async () => {
      // Arrange
      const user = userEvent.setup();
      renderMenu();
      await openDropdown(user);

      // Assert
      await waitFor(() => {
        const link = screen.getByRole('menuitem', { name: /download instrument \(csv\)/i });
        expect(link.closest('a')).toHaveAttribute('href', `${BASE_INSTRUMENT_URL}?format=csv`);
        expect(link.closest('a')).toHaveAttribute('download');
      });
    });
  });

  // ── Import dialog ──────────────────────────────────────────────────────────

  describe('import definition dialog', () => {
    it('dialog is closed on initial render', () => {
      // Arrange & Act
      renderMenu();

      // Assert: the stubbed dialog renders with open=false
      expect(screen.getByTestId('import-dialog')).toHaveAttribute('data-open', 'false');
    });

    it('clicking "Import definition (JSON)" opens the ImportDefinitionDialog', async () => {
      // Arrange
      const user = userEvent.setup();
      renderMenu();
      await openDropdown(user);

      // Act: select the import item
      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /import definition \(json\)/i })
        ).toBeInTheDocument();
      });
      const importItem = screen.getByRole('menuitem', { name: /import definition \(json\)/i });
      await user.click(importItem);

      // Assert: the dialog component receives open=true, proving setImportOpen(true) was called
      await waitFor(() => {
        expect(screen.getByTestId('import-dialog')).toHaveAttribute('data-open', 'true');
      });
    });
  });

  // ── Duplicate action ───────────────────────────────────────────────────────

  describe('duplicate questionnaire item', () => {
    it('calls duplicate with the questionnaireId when selected', async () => {
      // Arrange
      const mockDuplicate = vi.fn().mockResolvedValue(null);
      mockUseDuplicate.mockReturnValue({
        duplicate: mockDuplicate,
        isDuplicating: false,
        error: null,
        clearError: vi.fn(),
      });

      const user = userEvent.setup();
      renderMenu();
      await openDropdown(user);

      // Act: select the duplicate item
      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /duplicate this questionnaire/i })
        ).toBeInTheDocument();
      });
      const duplicateItem = screen.getByRole('menuitem', {
        name: /duplicate this questionnaire/i,
      });
      await user.click(duplicateItem);

      // Assert: the hook's duplicate function was called with the correct questionnaireId
      // (not just that it was called — the arg is what the code derives from props)
      await waitFor(() => {
        expect(mockDuplicate).toHaveBeenCalledWith(QID);
      });
    });

    it('uses the questionnaireId from props as the duplicate argument', async () => {
      // Arrange: different questionnaireId to prove it flows from props, not a constant
      const OTHER_QID = 'q-different';
      const mockDuplicate = vi.fn().mockResolvedValue(null);
      mockUseDuplicate.mockReturnValue({
        duplicate: mockDuplicate,
        isDuplicating: false,
        error: null,
        clearError: vi.fn(),
      });

      const user = userEvent.setup();
      renderMenu({ questionnaireId: OTHER_QID });
      await openDropdown(user);

      await waitFor(() => {
        expect(
          screen.getByRole('menuitem', { name: /duplicate this questionnaire/i })
        ).toBeInTheDocument();
      });
      await user.click(screen.getByRole('menuitem', { name: /duplicate this questionnaire/i }));

      await waitFor(() => {
        expect(mockDuplicate).toHaveBeenCalledWith(OTHER_QID);
      });
    });
  });

  // ── Error display ──────────────────────────────────────────────────────────

  describe('error display', () => {
    it('renders the error string from the hook when present', () => {
      // Arrange: hook returns an error message
      const errorMessage = 'Could not duplicate the questionnaire.';
      mockUseDuplicate.mockReturnValue({
        duplicate: vi.fn(),
        isDuplicating: false,
        error: errorMessage,
        clearError: vi.fn(),
      });

      // Act
      renderMenu();

      // Assert: the error is visible in the UI (no need to open the menu)
      expect(screen.getByText(errorMessage)).toBeInTheDocument();
    });

    it('does not render an error element when error is null', () => {
      // Arrange: default — error is null
      renderMenu();

      // Assert: no error text rendered
      expect(screen.queryByText('Could not duplicate the questionnaire.')).not.toBeInTheDocument();
    });
  });
});
