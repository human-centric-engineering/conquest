/**
 * PackExportDialog Component Tests
 *
 * Tests the "Download questionnaire pack" dialog — section checkboxes, format select, and the
 * download URL built from that state.
 *
 * Test Coverage:
 * - Five of the six section checkboxes are checked by default; "Evaluation findings" is not
 * - Download is disabled once every checkbox is unchecked, with a hint message
 * - Unchecking a single section still allows Download and reflects in the built URL
 * - Download navigates to the pack URL with format + include flags as query params
 * - Cancel closes the dialog without navigating
 *
 * @see components/admin/questionnaires/pack-export-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PackExportDialog } from '@/components/admin/questionnaires/pack-export-dialog';

const QID = 'q-abc';
const VID = 'v-xyz';
const BASE_URL = `/api/v1/app/questionnaires/${QID}/versions/${VID}/pack`;

function renderDialog(onOpenChange = vi.fn()) {
  render(
    <PackExportDialog open onOpenChange={onOpenChange} questionnaireId={QID} versionId={VID} />
  );
  return onOpenChange;
}

let originalLocation: Location;

beforeEach(() => {
  originalLocation = window.location;
  // happy-dom's window.location.href setter navigates for real — replace with a plain stub so
  // `new URL(relative, window.location.origin)` still resolves and the assignment is assertable.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin: 'http://localhost', href: 'http://localhost/admin' },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('PackExportDialog', () => {
  describe('section checkboxes', () => {
    it('renders six checkboxes, all checked by default except "Evaluation findings"', () => {
      renderDialog();
      const boxes = screen.getAllByRole('checkbox');
      expect(boxes).toHaveLength(6);
      for (const box of boxes.slice(0, 5)) expect(box).toBeChecked();
      expect(boxes[5]).not.toBeChecked();
    });

    it('disables Download and shows a hint once every checkbox is unchecked', async () => {
      const user = userEvent.setup();
      renderDialog();

      // Only the first five are checked by default — "Evaluation findings" starts unchecked.
      for (const box of screen.getAllByRole('checkbox').slice(0, 5)) {
        await user.click(box);
      }

      expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
      expect(screen.getByText(/pick at least one section/i)).toBeInTheDocument();
    });

    it('keeps Download enabled while at least one section remains checked', async () => {
      const user = userEvent.setup();
      renderDialog();

      const boxes = screen.getAllByRole('checkbox');
      for (const box of boxes.slice(0, 4)) await user.click(box);

      expect(screen.getByRole('button', { name: /download/i })).not.toBeDisabled();
    });
  });

  describe('download URL', () => {
    it('navigates to the pack URL with format=pdf, evaluations=false, and every other include flag true by default', async () => {
      const user = userEvent.setup();
      const onOpenChange = renderDialog();

      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain(BASE_URL);
      expect(window.location.href).toContain('format=pdf');
      expect(window.location.href).toContain('meta=true');
      expect(window.location.href).toContain('questions=true');
      expect(window.location.href).toContain('dataSlots=true');
      expect(window.location.href).toContain('definitions=true');
      expect(window.location.href).toContain('setup=true');
      expect(window.location.href).toContain('evaluations=false');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('reflects an unchecked section as its flag=false in the URL', async () => {
      const user = userEvent.setup();
      renderDialog();

      // "Data slots" is the second checkbox in document order.
      await user.click(screen.getAllByRole('checkbox')[2]);
      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain('dataSlots=false');
      expect(window.location.href).toContain('meta=true');
    });

    it('checking "Evaluation findings" reflects as evaluations=true in the URL', async () => {
      const user = userEvent.setup();
      renderDialog();

      // "Evaluation findings" is the sixth (last) checkbox in document order.
      await user.click(screen.getAllByRole('checkbox')[5]);
      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain('evaluations=true');
    });

    it('reflects a changed format selection in the URL', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: /csv/i }));
      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain('format=csv');
    });
  });

  describe('cancel', () => {
    it('closes the dialog without changing window.location', async () => {
      const user = userEvent.setup();
      const onOpenChange = renderDialog();
      const before = window.location.href;

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(window.location.href).toBe(before);
    });
  });
});
