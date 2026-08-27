// @vitest-environment jsdom

/**
 * SessionRefInput — the segmented session-reference field.
 *
 * Pins the behaviour the visual cells are there to support: one labelled field (not eight), input
 * folded to the canonical code as it is typed, the code's own length as a hard ceiling, and a
 * completion signal on the final character so the host form can submit itself.
 *
 * @see components/app/questionnaire/chat/session-ref-input.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { SessionRefInput } from '@/components/app/questionnaire/chat/session-ref-input';

/** Host that owns the value, mirroring how ResumeByRefForm drives the field. */
function Harness({ onComplete }: { onComplete?: (code: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <>
      <SessionRefInput value={value} onChange={setValue} onComplete={onComplete} />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe('SessionRefInput', () => {
  it('exposes exactly one field to assistive tech, not eight boxes', () => {
    render(<Harness />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByLabelText(/session reference code/i)).toBeInTheDocument();
  });

  it('folds typed input to the canonical code (case, grouping, look-alikes)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // `o` → `0` and `i` → `1` are the Crockford look-alikes; the dash is presentation only.
    await user.type(screen.getByLabelText(/session reference code/i), '7f3o-i m2');

    expect(screen.getByTestId('value')).toHaveTextContent('7F301M2');
  });

  it('accepts a pasted, grouped code', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText(/session reference code/i);
    await user.click(field);
    await user.paste('7F3K-9M2P');

    expect(screen.getByTestId('value')).toHaveTextContent('7F3K9M2P');
  });

  it('stops at the code length and fires onComplete once it is reached', async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(<Harness onComplete={onComplete} />);
    await user.type(screen.getByLabelText(/session reference code/i), '7F3K9M2PXXXX');

    expect(screen.getByTestId('value')).toHaveTextContent('7F3K9M2P');
    expect(onComplete).toHaveBeenCalledWith('7F3K9M2P');
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('renders the typed characters in their cells', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText(/session reference code/i), '7F3K');

    // The cells are presentational (aria-hidden), so assert on the rendered text.
    const cells = document.querySelectorAll('[aria-hidden] .font-mono');
    expect(Array.from(cells).map((c) => c.textContent)).toEqual([
      '7',
      'F',
      '3',
      'K',
      '',
      '',
      '',
      '',
    ]);
  });
});
