// @vitest-environment happy-dom

/**
 * PackExportDialog Component Tests
 *
 * Tests the "Download questionnaire pack" dialog — section checkboxes, format select, and the
 * download URL built from that state.
 *
 * Test Coverage:
 * - Five of the eight section checkboxes are checked by default; the three opt-in appendices
 *   ("Evaluation findings", "Conditional topics", "The interviewer") are not
 * - Nested sub-options: off by default, disabled with their parent, and not counted as sections by
 *   the "pick at least one" gate
 * - Download is disabled once every SECTION checkbox is unchecked, with a hint message
 * - Unchecking a single section still allows Download and reflects in the built URL
 * - Download navigates to the pack URL with format + include flags as query params
 * - Cancel closes the dialog without navigating
 *
 * Assertions are by accessible NAME rather than by index, deliberately: the previous index-based
 * form encoded "there are seven sections and the last two are the opt-in ones", which silently
 * became wrong the moment an eighth was added and would have failed with an off-by-one rather than
 * with anything a reader could act on.
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

/**
 * The top-level section checkboxes, in document order — excludes every nested sub-option.
 *
 * Read off `data-suboption`, which the dialog stamps on every refinement, rather than a hard-coded
 * id list: the list form was already wrong once, silently counting four new sub-options as sections
 * and only failing on a total.
 */
function sectionBoxes(): HTMLElement[] {
  return screen
    .getAllByRole('checkbox')
    .filter((box) => box.getAttribute('data-suboption') === null);
}

/** The sections ticked on open — what "unchecking everything" actually has to click. */
function checkedSectionBoxes(): HTMLElement[] {
  return sectionBoxes().filter((box) => (box as HTMLInputElement).checked);
}

const technicalBox = () => screen.getByRole('checkbox', { name: /technical & tuning/i });

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
    it('renders eight section checkboxes, all checked by default except the three opt-in appendices', () => {
      renderDialog();
      expect(sectionBoxes()).toHaveLength(8);

      // Anchored, because a checkbox's accessible name is its label AND its description — an
      // unanchored /questions/ matches half the dialog.
      for (const name of [
        /^Title, version & goals\b/,
        /^Questions\b/,
        /^Data slots\b/,
        /^Definitions\b/,
        /^Experience setup\b/,
      ]) {
        expect(screen.getByRole('checkbox', { name })).toBeChecked();
      }

      // The three that ship unreviewed AI critique or the instrument's routing design, and so are
      // opted into per download rather than opted out of.
      for (const name of [/evaluation findings/i, /conditional topics/i, /the interviewer/i]) {
        expect(screen.getByRole('checkbox', { name })).not.toBeChecked();
      }
    });

    it('offers "The interviewer" as a section at all', () => {
      // It shipped on `PackInclude` and on the route with no checkbox here, so the section existed
      // and could not be asked for. A name assertion is the cheap guard against that recurring.
      renderDialog();
      expect(screen.getByRole('checkbox', { name: /the interviewer/i })).toBeInTheDocument();
    });

    it('offers the evaluation sub-options with the conclusions on and the bulk off', async () => {
      // The shape that makes a slim pack readable: what the panel wants done and the wording it
      // proposes, without the four near-identical arguments for it.
      renderDialog();
      expect(screen.getByRole('checkbox', { name: /panel's verdict/i })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /suggested rewordings/i })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /every judge's reasoning/i })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: /evidence quotes/i })).not.toBeChecked();
    });

    it('disables the evaluation sub-options while "Evaluation findings" is off', () => {
      // Which is the default state, so this is what an admin sees on opening the dialog: the
      // refinements are visible (they say what ticking the parent would give) but inert.
      renderDialog();
      expect(screen.getByRole('checkbox', { name: /panel's verdict/i })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: /every judge's reasoning/i })).toBeDisabled();
    });

    it('enables them once the parent section is ticked', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(screen.getByRole('checkbox', { name: /evaluation findings/i }));

      expect(screen.getByRole('checkbox', { name: /panel's verdict/i })).not.toBeDisabled();
    });

    it('keeps a sub-option’s value when its parent is unticked and re-ticked', async () => {
      // Unticking a section is not a decision to reset how it should be rendered. An admin who
      // turns judge reasoning on, changes their mind about the section, then changes it back must
      // not silently lose the refinement they set.
      const user = userEvent.setup();
      renderDialog();

      await user.click(screen.getByRole('checkbox', { name: /evaluation findings/i }));
      await user.click(screen.getByRole('checkbox', { name: /every judge's reasoning/i }));
      expect(screen.getByRole('checkbox', { name: /every judge's reasoning/i })).toBeChecked();

      await user.click(screen.getByRole('checkbox', { name: /evaluation findings/i }));
      await user.click(screen.getByRole('checkbox', { name: /evaluation findings/i }));

      expect(screen.getByRole('checkbox', { name: /every judge's reasoning/i })).toBeChecked();
    });

    it('starts the nested technical sub-option unchecked, enabled under a checked parent', () => {
      renderDialog();
      expect(technicalBox()).not.toBeChecked();
      expect(technicalBox()).not.toBeDisabled();
    });

    it('disables the technical sub-option when "Experience setup" is unchecked', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(screen.getByRole('checkbox', { name: /experience setup/i }));

      expect(technicalBox()).toBeDisabled();
    });

    it('disables Download and shows a hint once every checkbox is unchecked', async () => {
      const user = userEvent.setup();
      renderDialog();

      for (const box of checkedSectionBoxes()) {
        await user.click(box);
      }

      expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
      expect(screen.getByText(/pick at least one section/i)).toBeInTheDocument();
    });

    it('does not count the technical sub-option as a section for the "pick at least one" gate', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(technicalBox());
      for (const box of checkedSectionBoxes()) await user.click(box);

      // The sub-option is ticked, but it produces nothing on its own — Download stays disabled.
      expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
    });

    it('keeps Download enabled while at least one section remains checked', async () => {
      const user = userEvent.setup();
      renderDialog();

      // All but one of the ticked sections off — the last one keeps Download alive.
      for (const box of checkedSectionBoxes().slice(0, -1)) await user.click(box);

      expect(screen.getByRole('button', { name: /download/i })).not.toBeDisabled();
    });
  });

  describe('download URL', () => {
    it('navigates to the pack URL with format=pdf, evaluations=false, conditionalTopics=false, and every other include flag true by default', async () => {
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
      expect(window.location.href).toContain('conditionalTopics=false');
      expect(window.location.href).toContain('interviewerPolicy=false');
      expect(window.location.href).toContain('setupTechnical=false');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('checking "The interviewer" reflects as interviewerPolicy=true in the URL', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(screen.getByRole('checkbox', { name: /the interviewer/i }));
      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain('interviewerPolicy=true');
    });

    it('reflects an unchecked section as its flag=false in the URL', async () => {
      const user = userEvent.setup();
      renderDialog();

      // "Data slots" is the third section checkbox in document order.
      await user.click(sectionBoxes()[2]);
      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain('dataSlots=false');
      expect(window.location.href).toContain('meta=true');
    });

    it('checking "Evaluation findings" reflects as evaluations=true in the URL', async () => {
      const user = userEvent.setup();
      renderDialog();

      // "Evaluation findings" is the sixth section checkbox in document order.
      await user.click(sectionBoxes()[5]);
      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain('evaluations=true');
    });

    it('checking "Conditional topics" reflects as conditionalTopics=true in the URL', async () => {
      const user = userEvent.setup();
      renderDialog();

      // By name, not by index. The index form said "the seventh (last) section", which stopped
      // being true the moment an eighth was added — the exact drift this file's header warns about.
      await user.click(screen.getByRole('checkbox', { name: /conditional topics/i }));
      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain('conditionalTopics=true');
    });

    it('checking "Technical & tuning settings" reflects as setupTechnical=true in the URL', async () => {
      const user = userEvent.setup();
      renderDialog();

      await user.click(technicalBox());
      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(window.location.href).toContain('setupTechnical=true');
      expect(window.location.href).toContain('setup=true');
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
