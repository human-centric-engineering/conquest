// @vitest-environment happy-dom

/**
 * BrandColorField tests.
 *
 * The demo-client form's colour control: a styled swatch with a transparent `<input type="color">`
 * laid over it, plus a hex box, both driving one value. Almost every behaviour here exists because
 * a native colour input has no empty state, and blank is meaningful on this form ("no colour", or
 * "derive it for me"). So the tests are mostly about the UNSET state:
 *  - unset draws the slash and paints no background, rather than reading as black
 *  - unset still opens the picker, seeded from a hex placeholder (not from black)
 *  - a prose placeholder cannot seed the picker — it falls back to mid-grey
 *  - the control never calls `onChange` on its own, so an untouched field stores nothing
 *  - `aria-invalid` fires on a malformed hex but NOT on empty, or the form is invalid on first paint
 *  - the two controls are separately labelled, and both report edits through the same `onChange`
 *
 * @see components/admin/demo-clients/brand-color-field.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrandColorField } from '@/components/admin/demo-clients/brand-color-field';

function setup(props: Partial<React.ComponentProps<typeof BrandColorField>> = {}) {
  const onChange = vi.fn();
  render(
    <BrandColorField
      id="canvasColor"
      label="Canvas colour"
      help="The page ground."
      value=""
      onChange={onChange}
      {...props}
    />
  );
  return { onChange };
}

/**
 * The hex box. Found by role rather than by label: the `<Label>` and the `FieldHelp` trigger it
 * contains both carry the field's name, so a label query is ambiguous by construction here.
 */
const hexBox = () => screen.getByRole('textbox');
/** The colour input — deliberately labelled apart, so a screen reader can tell the two apart. */
const picker = () => screen.getByLabelText('Canvas colour picker');
/** The styled swatch the transparent picker sits on top of. */
const swatch = () => picker().parentElement as HTMLElement;

describe('BrandColorField', () => {
  describe('the unset state', () => {
    it('paints no background and marks the swatch dashed', () => {
      setup({ value: '' });
      // Pinned as "no inline background" rather than "not black": the bug this guards against is
      // an unset field rendering the picker's default colour as though it were a chosen one.
      expect(swatch().style.backgroundColor).toBe('');
      expect(swatch().className).toContain('border-dashed');
    });

    it('draws the slash that says "nothing chosen"', () => {
      const { container } = render(
        <BrandColorField id="c" label="Canvas colour" help="h" value="" onChange={vi.fn()} />
      );
      expect(container.querySelector('svg line')).not.toBeNull();
    });

    it('seeds the picker from a hex placeholder rather than from black', () => {
      // The whole reason the seed exists: clicking an untouched swatch should open the OS picker
      // on the suggested colour, not on #000000.
      setup({ value: '', placeholder: '#280039' });
      expect(picker()).toHaveValue('#280039');
    });

    it('falls back to mid-grey when the placeholder is prose, not a colour', () => {
      // Several fields placeholder with "Leave blank to derive it" — which is exactly where the
      // unset state matters most, so this path must not try to feed prose to the colour input.
      setup({ value: '', placeholder: 'Leave blank to derive it' });
      expect(picker()).toHaveValue('#808080');
    });

    it('never reports a value of its own — an untouched field stores nothing', () => {
      const { onChange } = setup({ value: '', placeholder: '#280039' });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not flag an empty field as invalid', () => {
      // Flagging blank would mark most of this form invalid on first paint, since blank is the
      // path most clients take for ink and the dark canvas.
      setup({ value: '' });
      expect(hexBox()).toHaveAttribute('aria-invalid', 'false');
    });
  });

  describe('with a colour set', () => {
    it('paints the swatch and drops the dashed edge', () => {
      setup({ value: '#280039' });
      expect(swatch().style.backgroundColor).toBe('#280039');
      expect(swatch().className).not.toContain('border-dashed');
    });

    it('shows the value in both controls', () => {
      setup({ value: '#280039' });
      expect(picker()).toHaveValue('#280039');
      expect(hexBox()).toHaveValue('#280039');
    });

    it('treats a value with surrounding whitespace as set', () => {
      // A hex pasted out of a brand guideline often arrives padded.
      setup({ value: '  #280039  ' });
      expect(swatch().style.backgroundColor).toBe('#280039');
      expect(hexBox()).toHaveAttribute('aria-invalid', 'false');
    });

    it('flags a malformed hex once there is something to be wrong about', () => {
      setup({ value: '#nothex' });
      expect(hexBox()).toHaveAttribute('aria-invalid', 'true');
      // Still unset as far as the swatch is concerned — a bad value must not be painted.
      expect(swatch().style.backgroundColor).toBe('');
    });
  });

  describe('reporting edits', () => {
    it('reports what the admin types into the hex box', async () => {
      const user = userEvent.setup();
      const { onChange } = setup({ value: '' });
      await user.type(hexBox(), '#');
      expect(onChange).toHaveBeenCalledWith('#');
    });

    it('reports what the picker returns', () => {
      const { onChange } = setup({ value: '' });
      // `userEvent` cannot drive an OS colour picker, so the change is fired directly — the
      // assertion is that the handler forwards the input's value, which is all this layer does.
      fireEvent.change(picker(), { target: { value: '#123456' } });
      expect(onChange).toHaveBeenCalledWith('#123456');
    });
  });

  describe('disabled and error states', () => {
    it('disables both controls together', () => {
      setup({ value: '#280039', disabled: true });
      expect(picker()).toBeDisabled();
      expect(hexBox()).toBeDisabled();
      expect(swatch().className).toContain('opacity-50');
    });

    it('renders a field error when one is given', () => {
      setup({ value: '#nothex', error: 'Not a valid hex colour' });
      expect(screen.getByText('Not a valid hex colour')).toBeInTheDocument();
    });

    it('renders no error node when there is none', () => {
      setup({ value: '#280039' });
      expect(screen.queryByText(/valid hex/i)).toBeNull();
    });
  });
});
