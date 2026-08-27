// @vitest-environment happy-dom

/**
 * QuestionnairePackButton — the workspace-header CTA that promotes the Questionnaire Pack out of
 * the Structure tab's "Export / download" dropdown, so it's reachable from every workspace tab.
 *
 * The dialog is stubbed to a marker element: its own behaviour (section checkboxes, format select,
 * download URL) is covered by pack-export-dialog.test.tsx. What matters here is that the button
 * renders discoverably, forwards its ids, and owns the dialog's open state.
 *
 * Test Coverage:
 * - Renders a button labelled "Questionnaire pack" with a descriptive title attribute
 * - The dialog starts closed
 * - Clicking the button opens the dialog
 * - The dialog's onOpenChange(false) closes it again
 * - questionnaireId / versionId are forwarded to the dialog unchanged
 *
 * @see components/admin/questionnaires/workspace/questionnaire-pack-button.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Stub the dialog to a marker element carrying its props, so we can assert on `open` and the
 * forwarded ids without rendering the full dialog tree. The close button lets us drive
 * `onOpenChange(false)` the way a real dismissal would.
 */
vi.mock('@/components/admin/questionnaires/pack-export-dialog', () => ({
  PackExportDialog: ({
    open,
    onOpenChange,
    questionnaireId,
    versionId,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    questionnaireId: string;
    versionId: string;
  }) => (
    <div
      data-testid="pack-dialog"
      data-open={String(open)}
      data-questionnaire-id={questionnaireId}
      data-version-id={versionId}
    >
      <button type="button" onClick={() => onOpenChange(false)}>
        close-dialog
      </button>
    </div>
  ),
}));

// ─── Component import (after mocks) ──────────────────────────────────────────

import { QuestionnairePackButton } from '@/components/admin/questionnaires/workspace/questionnaire-pack-button';

function renderButton() {
  return render(<QuestionnairePackButton questionnaireId="q-1" versionId="v-1" />);
}

/** The header CTA itself — not the stub's close button. */
function packButton() {
  return screen.getByRole('button', { name: /questionnaire pack/i });
}

describe('QuestionnairePackButton', () => {
  it('renders a discoverable "Questionnaire pack" button with a descriptive title', () => {
    // Act
    renderButton();

    // Assert: the label is the whole point of promoting it out of the dropdown
    expect(packButton()).toBeInTheDocument();
    expect(packButton().getAttribute('title')).toContain('branded, shareable pack');
  });

  it('starts with the dialog closed', () => {
    // Act
    renderButton();

    // Assert
    expect(screen.getByTestId('pack-dialog')).toHaveAttribute('data-open', 'false');
  });

  it('opens the PackExportDialog when clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    renderButton();

    // Act
    await user.click(packButton());

    // Assert
    await waitFor(() => {
      expect(screen.getByTestId('pack-dialog')).toHaveAttribute('data-open', 'true');
    });
  });

  it('closes again when the dialog reports onOpenChange(false)', async () => {
    // Arrange
    const user = userEvent.setup();
    renderButton();
    await user.click(packButton());
    await waitFor(() => {
      expect(screen.getByTestId('pack-dialog')).toHaveAttribute('data-open', 'true');
    });

    // Act: the dialog dismisses itself (escape, overlay click, or a completed download)
    await user.click(screen.getByRole('button', { name: 'close-dialog' }));

    // Assert
    await waitFor(() => {
      expect(screen.getByTestId('pack-dialog')).toHaveAttribute('data-open', 'false');
    });
  });

  it('forwards questionnaireId and versionId to the dialog', () => {
    // Act
    renderButton();

    // Assert: a wrong id here would download another version's pack
    const dialog = screen.getByTestId('pack-dialog');
    expect(dialog).toHaveAttribute('data-questionnaire-id', 'q-1');
    expect(dialog).toHaveAttribute('data-version-id', 'v-1');
  });
});
