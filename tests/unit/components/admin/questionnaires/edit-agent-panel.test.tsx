/**
 * EditAgentPanel component tests.
 *
 * Anti-green-bar: drives the panel the way an admin does (type → preview → apply / discard) and
 * asserts the rendered preview, the outbound requests, and the `onApplied` callback — not mock
 * internals. The endpoints are mocked at the `fetch` boundary (the panel uses global fetch +
 * parseApiResponse).
 *
 * @see components/admin/questionnaires/edit-agent-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EditAgentPanel } from '@/components/admin/questionnaires/edit-agent-panel';

const PRECISE_PLAN = {
  mode: 'precise',
  summary: 'Make free-text optional',
  operations: [
    { op: 'set_required', target: { scope: 'type', questionType: 'free_text' }, value: false },
  ],
  changes: [
    {
      entity: 'question',
      entityId: 'q1',
      key: 'name',
      label: 'Your name?',
      field: 'question.required',
      before: 'required',
      after: 'optional',
      value: false,
    },
  ],
};

/** Route the fetch mock by URL so plan and apply can return different payloads. */
function mockFetch(planPayload: unknown, applyOk = true): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/edit-agent/plan')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: planPayload }),
      });
    }
    // apply
    return Promise.resolve({
      ok: applyOk,
      status: applyOk ? 200 : 409,
      json: async () =>
        applyOk
          ? {
              success: true,
              data: { mode: 'precise', changeCount: 1, sectionCount: 0, questionCount: 1 },
            }
          : { success: false, error: { code: 'EDIT_HAS_SESSIONS', message: 'has sessions' } },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPanel(overrides: Partial<Parameters<typeof EditAgentPanel>[0]> = {}) {
  const onApplied = vi.fn();
  render(
    <EditAgentPanel
      questionnaireId="qn-1"
      versionId="v1"
      status="draft"
      busy={false}
      onApplied={onApplied}
      {...overrides}
    />
  );
  return { onApplied };
}

describe('EditAgentPanel', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('shows a disabled hint on a non-draft version (no instruction field)', () => {
    renderPanel({ status: 'launched' });
    expect(screen.getByText(/available on draft versions only/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit instruction')).not.toBeInTheDocument();
  });

  it('previews changes then applies, calling onApplied', async () => {
    const fetchMock = mockFetch(PRECISE_PLAN);
    const { onApplied } = renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'remove required from free text');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));

    // Preview renders the summary + the before→after row, and does NOT apply yet.
    await screen.findByText('Make free-text optional');
    expect(screen.getByText('optional')).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();

    // The plan request carried the instruction + default precise mode.
    const planBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(planBody).toMatchObject({
      instruction: 'remove required from free text',
      mode: 'precise',
    });

    await user.click(screen.getByRole('button', { name: /apply changes/i }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));

    // The apply request sent the planned operations, not the change list.
    const applyCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/apply'));
    expect(JSON.parse(applyCall![1].body)).toMatchObject({
      mode: 'precise',
      operations: PRECISE_PLAN.operations,
    });
  });

  it('discards a preview without applying', async () => {
    mockFetch(PRECISE_PLAN);
    const { onApplied } = renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'do it');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));
    await screen.findByText('Make free-text optional');

    await user.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.queryByText('Make free-text optional')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preview changes/i })).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('surfaces an apply error and does not call onApplied', async () => {
    mockFetch(PRECISE_PLAN, false);
    const { onApplied } = renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'do it');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));
    await screen.findByText('Make free-text optional');
    await user.click(screen.getByRole('button', { name: /apply changes/i }));

    await screen.findByText('has sessions');
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('reports an empty plan as no changes', async () => {
    mockFetch({ mode: 'precise', summary: 'Nothing matched', operations: [], changes: [] });
    renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'frobnicate');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));

    await screen.findByText(/no changes/i);
    // Apply is disabled when there is nothing to apply.
    expect(screen.getByRole('button', { name: /apply changes/i })).toBeDisabled();
  });
});
