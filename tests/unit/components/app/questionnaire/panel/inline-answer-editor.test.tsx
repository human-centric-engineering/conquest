/**
 * InlineAnswerEditor — the shared "fix this answer" editor (Variant B). Pins the contract the
 * correction gesture depends on: editing a field and saving PUTs the batch to `…/answers`, an
 * emptied value saves a clear, a successful save calls back + closes, and Cancel discards.
 *
 * @see components/app/questionnaire/panel/inline-answer-editor.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { InlineAnswerEditor } from '@/components/app/questionnaire/panel/inline-answer-editor';
import type { EditableQuestion } from '@/lib/app/questionnaire/panel/correction-targets';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: {} }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function textQuestion(value: unknown): EditableQuestion {
  return {
    slot: { slotKey: 'role', prompt: 'Your role?', type: 'free_text', typeConfig: null },
    initialValue: value,
  };
}

/** The most recent PUT call's parsed body. */
function lastPutBody() {
  const put = [...fetchMock.mock.calls].reverse().find((c) => c[1]?.method === 'PUT');
  return put ? JSON.parse(put[1].body as string) : null;
}

describe('InlineAnswerEditor', () => {
  it('seeds the field with the current value and PUTs the edited value on Save', async () => {
    const onSaved = vi.fn();
    render(
      <InlineAnswerEditor
        questions={[textQuestion('Engineer')]}
        sessionId="sess-1"
        onSaved={onSaved}
        onCancel={vi.fn()}
      />
    );

    const field = screen.getByDisplayValue('Engineer');
    fireEvent.change(field, { target: { value: 'Designer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // onSaved receives the refreshed panel view (the PUT response's `data`) — the arg is the
    // contract the panel refetch depends on, so assert the value, not just that it fired.
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({}));
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', value: 'Designer' }] });
  });

  it('sends a clear when the value is emptied', async () => {
    const onSaved = vi.fn();
    render(
      <InlineAnswerEditor
        questions={[textQuestion('Engineer')]}
        sessionId="sess-1"
        onSaved={onSaved}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getByDisplayValue('Engineer'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastPutBody()).toEqual({ answers: [{ questionKey: 'role', clear: true }] });
  });

  it('forwards the anonymous session token as X-Session-Token', async () => {
    render(
      <InlineAnswerEditor
        questions={[textQuestion('Engineer')]}
        sessionId="sess-1"
        accessToken="tok-abc"
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-Session-Token']).toBe('tok-abc');
  });

  it('Cancel discards without saving', () => {
    const onCancel = vi.fn();
    render(
      <InlineAnswerEditor
        questions={[textQuestion('Engineer')]}
        sessionId="sess-1"
        onSaved={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces an error and keeps the editor open when the save fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({}) });
    const onSaved = vi.fn();
    render(
      <InlineAnswerEditor
        questions={[textQuestion('Engineer')]}
        sessionId="sess-1"
        onSaved={onSaved}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
