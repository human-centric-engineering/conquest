/**
 * QuestionCoverageEditor component tests.
 *
 * Anti-green-bar: asserts the rendered chips/labels, the Edit + View popovers, and that toggling
 * a question fires `onToggle` with the right key — the behaviour an admin relies on to map a data
 * slot to the questions it covers. Also covers the stale-key path (a mapped key not in the current
 * version).
 *
 * @see components/admin/questionnaires/question-coverage-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { QuestionCoverageEditor } from '@/components/admin/questionnaires/question-coverage-editor';

const QUESTIONS = [
  { key: 'q1', prompt: 'What is your goal?' },
  { key: 'q2', prompt: 'What is your timeline?' },
  { key: 'q3', prompt: 'What is your budget?' },
];

function renderEditor(selectedKeys: string[] = ['q1']) {
  const onToggle = vi.fn();
  render(
    <QuestionCoverageEditor questions={QUESTIONS} selectedKeys={selectedKeys} onToggle={onToggle} />
  );
  return { onToggle };
}

describe('QuestionCoverageEditor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('labels the covered-key count and explains a question key via FieldHelp', async () => {
    const user = userEvent.setup();
    renderEditor(['q1', 'q2']);
    expect(screen.getByText(/Covered question keys \(2 of 3\)/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /more information/i }));
    expect(await screen.findByText(/short, stable identifier/i)).toBeInTheDocument();
  });

  it('renders a removable chip per selected key', () => {
    renderEditor(['q1', 'q2']);
    expect(screen.getByText('q1')).toBeInTheDocument();
    expect(screen.getByText('q2')).toBeInTheDocument();
  });

  it('does not remove a chip until the "are you sure" is confirmed', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderEditor(['q1', 'q2']);

    await user.click(screen.getByRole('button', { name: 'Remove q1' }));

    // Guarded — nothing is removed on the bare click.
    expect(onToggle).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/remove this question key/i)).toBeInTheDocument();
    // The warning spells out the targeting risk.
    expect(within(dialog).getByText(/no longer be targeted/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/inadvisable/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /remove anyway/i }));
    expect(onToggle).toHaveBeenCalledWith('q1');
  });

  it('keeps the chip when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderEditor(['q1', 'q2']);

    await user.click(screen.getByRole('button', { name: 'Remove q1' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /keep it/i }));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('shows the empty-state hint when no keys are mapped', () => {
    renderEditor([]);
    expect(
      screen.getByText(
        /No question keys mapped — the respondent flow will ask these questions directly/i
      )
    ).toBeInTheDocument();
  });

  it('Edit popover toggles a question by key', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderEditor(['q1']);

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const popover = await screen.findByRole('dialog');
    // q2 is not yet covered → clicking it adds the mapping.
    await user.click(within(popover).getByRole('button', { name: /q2.*timeline/i }));
    expect(onToggle).toHaveBeenCalledWith('q2');
  });

  it('Edit popover filters the question list', async () => {
    const user = userEvent.setup();
    renderEditor(['q1']);

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const popover = await screen.findByRole('dialog');
    await user.type(within(popover).getByPlaceholderText(/filter questions/i), 'budget');

    expect(within(popover).getByRole('button', { name: /q3.*budget/i })).toBeInTheDocument();
    expect(
      within(popover).queryByRole('button', { name: /q2.*timeline/i })
    ).not.toBeInTheDocument();
    expect(within(popover).queryByRole('button', { name: /q1.*goal/i })).not.toBeInTheDocument();
  });

  it('Edit popover shows the empty-state when the filter matches nothing', async () => {
    const user = userEvent.setup();
    renderEditor(['q1']);

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    const popover = await screen.findByRole('dialog');
    await user.type(within(popover).getByPlaceholderText(/filter questions/i), 'zzz-no-match');

    expect(within(popover).getByText('No matching questions.')).toBeInTheDocument();
  });

  it('View popover shows the prompt text of each covered question', async () => {
    const user = userEvent.setup();
    renderEditor(['q2']);

    await user.click(screen.getByRole('button', { name: /view questions/i }));
    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText('q2')).toBeInTheDocument();
    expect(within(popover).getByText('What is your timeline?')).toBeInTheDocument();
  });

  it('flags a stale key (mapped but not in this version) with a drop-on-save warning', async () => {
    const user = userEvent.setup();
    renderEditor(['q1', 'gone_key']);

    expect(
      screen.getByText(/1 mapped key.*aren’t in this version.*dropped on save/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /view questions/i }));
    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText(/Not in this version/i)).toBeInTheDocument();
  });
});
