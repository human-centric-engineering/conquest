/**
 * EditAgentPanel component tests.
 *
 * Anti-green-bar: drives the panel the way an admin does (type → preview → apply / discard) and
 * asserts the rendered preview, the outbound requests, and the `onApplied` / `onForked` callbacks —
 * not mock internals. The endpoints are mocked at the `fetch` boundary (the panel previews via
 * global fetch and applies via `authoringMutate`, which also uses global fetch).
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

/** A precise plan exercising every `changeVerb` field kind (not just `question.required`). */
const ALL_VERBS_PLAN = {
  mode: 'precise',
  summary: 'Multiple structural changes',
  operations: [],
  changes: [
    {
      entity: 'section',
      entityId: 's1',
      key: 'sec-a',
      label: 'Background',
      field: 'section.title',
      before: 'Background',
      after: 'BACKGROUND',
      value: 'BACKGROUND',
    },
    {
      entity: 'section',
      entityId: 's1',
      key: 'sec-a',
      label: 'Background',
      field: 'section.ordinal',
      before: '0',
      after: '1',
      value: 1,
    },
    {
      entity: 'question',
      entityId: 'q1',
      key: 'name',
      label: 'Name?',
      field: 'question.prompt',
      before: 'Name?',
      after: 'Full name?',
      value: 'Full name?',
    },
    {
      entity: 'question',
      entityId: 'q1',
      key: 'name',
      label: 'Name?',
      field: 'question.weight',
      before: '0.5',
      after: '0.8',
      value: 0.8,
    },
    {
      entity: 'question',
      entityId: 'q1',
      key: 'name',
      label: 'Name?',
      field: 'question.ordinal',
      before: '0',
      after: '1',
      value: 1,
    },
    {
      entity: 'question',
      entityId: 'q1',
      key: 'name',
      label: 'Name?',
      field: 'question.section',
      before: 'Background',
      after: 'Details',
      value: 'sec-b',
      toSectionId: 'sec-b',
    },
  ],
};

/** A rewrite-mode plan — whole-doc regenerate, rendered as an outline instead of before→after rows. */
const REWRITE_PLAN = {
  mode: 'rewrite',
  summary: 'Rewrote the whole thing',
  structure: {
    sections: [{ ordinal: 0, title: 'Intro' }],
    questions: [],
  },
  outline: [
    { title: 'Intro', questionCount: 2 },
    { title: 'Details', questionCount: 1 },
  ],
};

/** The 409 shape the fork-confirmation protocol returns; a valid `details` triggers the prompt. */
const FORK_CONFIRM_DETAILS = {
  sourceVersionNumber: 1,
  nextVersionNumber: 2,
  versions: [{ versionNumber: 1, status: 'launched' }],
};

/** Apply-response variants the fetch mock can return. */
type ApplyResult =
  | { kind: 'ok'; meta?: { forked: boolean; versionId: string; versionNumber: number } }
  | { kind: 'error'; code: string; message: string }
  // A 409 the admin can confirm/decline. No `ForkConfirmProvider` is mounted in these tests, so
  // `requestForkConfirm` resolves `false` and `authoringMutate` throws `ForkCancelledError`.
  | { kind: 'forkConfirm' };

/** Route the fetch mock by URL so plan and apply can return different payloads. */
function mockFetch(
  planPayload: unknown,
  apply: ApplyResult = { kind: 'ok' }
): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/edit-agent/plan')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: planPayload }),
      });
    }
    // apply (issued by authoringMutate)
    if (apply.kind === 'error') {
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({ success: false, error: { code: apply.code, message: apply.message } }),
      });
    }
    if (apply.kind === 'forkConfirm') {
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({
          success: false,
          error: {
            code: 'VERSION_FORK_CONFIRMATION_REQUIRED',
            message: 'Confirm the fork',
            details: FORK_CONFIRM_DETAILS,
          },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { mode: 'precise', changeCount: 1, sectionCount: 0, questionCount: 1 },
        ...(apply.meta ? { meta: apply.meta } : {}),
      }),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPanel(overrides: Partial<Parameters<typeof EditAgentPanel>[0]> = {}) {
  const onApplied = vi.fn();
  const onForked = vi.fn();
  render(
    <EditAgentPanel
      questionnaireId="qn-1"
      versionId="v1"
      status="draft"
      busy={false}
      onApplied={onApplied}
      onForked={onForked}
      {...overrides}
    />
  );
  return { onApplied, onForked };
}

describe('EditAgentPanel', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('shows a disabled hint on an archived version (no instruction field)', () => {
    renderPanel({ status: 'archived' });
    expect(screen.getByText(/unavailable on archived versions/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit instruction')).not.toBeInTheDocument();
  });

  it('is editable on a launched version (apply will fork a new draft)', () => {
    renderPanel({ status: 'launched' });
    expect(screen.getByLabelText('Edit instruction')).toBeInTheDocument();
    expect(screen.queryByText(/unavailable on archived versions/i)).not.toBeInTheDocument();
  });

  it('previews changes then applies, calling onApplied', async () => {
    const fetchMock = mockFetch(PRECISE_PLAN);
    const { onApplied, onForked } = renderPanel();
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
    expect(onForked).not.toHaveBeenCalled();

    // The apply request sent the planned operations, not the change list, and opted into the
    // fork-confirmation protocol (x-fork-confirm) so a session-pinned version bumps a new draft.
    const applyCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/apply'));
    expect(JSON.parse(applyCall![1].body)).toMatchObject({
      mode: 'precise',
      operations: PRECISE_PLAN.operations,
    });
    expect(applyCall![1].headers).toMatchObject({ 'x-fork-confirm': 'prompt' });
  });

  it('routes a forked apply to onForked (not onApplied) and redirects the parent', async () => {
    mockFetch(PRECISE_PLAN, {
      kind: 'ok',
      meta: { forked: true, versionId: 'v2', versionNumber: 2 },
    });
    const { onApplied, onForked } = renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'remove required from free text');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));
    await screen.findByText('Make free-text optional');
    await user.click(screen.getByRole('button', { name: /apply changes/i }));

    await waitFor(() =>
      expect(onForked).toHaveBeenCalledWith({ forked: true, versionId: 'v2', versionNumber: 2 })
    );
    expect(onApplied).not.toHaveBeenCalled();
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
    mockFetch(PRECISE_PLAN, {
      kind: 'error',
      code: 'EDIT_PLAN_INVALID',
      message: 'That edit could not be applied',
    });
    const { onApplied, onForked } = renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'do it');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));
    await screen.findByText('Make free-text optional');
    await user.click(screen.getByRole('button', { name: /apply changes/i }));

    await screen.findByText('That edit could not be applied');
    expect(onApplied).not.toHaveBeenCalled();
    expect(onForked).not.toHaveBeenCalled();
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

  it('renders a distinct verb for every precise change field, not just question.required', async () => {
    mockFetch(ALL_VERBS_PLAN);
    renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'restructure everything');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));

    await screen.findByText('Multiple structural changes');
    expect(screen.getByText(/Rename section/)).toBeInTheDocument();
    expect(screen.getByText(/Reorder section/)).toBeInTheDocument();
    expect(screen.getByText(/Reword prompt/)).toBeInTheDocument();
    expect(screen.getByText(/Set weight/)).toBeInTheDocument();
    expect(screen.getByText(/Reorder question/)).toBeInTheDocument();
    expect(screen.getByText(/Move question/)).toBeInTheDocument();
  });

  it('previews and applies a whole-document rewrite, rendering the outline', async () => {
    const fetchMock = mockFetch(REWRITE_PLAN);
    const { onApplied, onForked } = renderPanel();
    const user = userEvent.setup();

    // Switch to rewrite mode before previewing.
    await user.click(screen.getByRole('button', { name: /full rewrite/i }));
    await user.type(screen.getByLabelText('Edit instruction'), 'regenerate the whole thing');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));

    await screen.findByText('Rewrote the whole thing');
    // The outline (not before→after rows) renders for a rewrite plan.
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText('(2 questions)')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('(1 question)')).toBeInTheDocument();

    // The plan request carried the rewrite mode.
    const planBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(planBody).toMatchObject({ mode: 'rewrite' });

    await user.click(screen.getByRole('button', { name: /apply changes/i }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onForked).not.toHaveBeenCalled();

    // The apply request sends the full structure, not an operations list.
    const applyCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/apply'));
    expect(JSON.parse(applyCall![1].body)).toMatchObject({
      mode: 'rewrite',
      structure: REWRITE_PLAN.structure,
    });
  });

  it('can switch back to precise mode after selecting rewrite', async () => {
    const fetchMock = mockFetch(PRECISE_PLAN);
    renderPanel();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /full rewrite/i }));
    await user.click(screen.getByRole('button', { name: /precise edits/i }));
    await user.type(screen.getByLabelText('Edit instruction'), 'do it precisely');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));

    await screen.findByText('Make free-text optional');
    const planBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(planBody).toMatchObject({ mode: 'precise' });
  });

  it('shows a server validation error without entering the preview state', async () => {
    const fn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/edit-agent/plan')) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            success: false,
            error: { code: 'VALIDATION_ERROR', message: 'Instruction is too vague' },
          }),
        });
      }
      throw new Error('apply should not be called');
    });
    vi.stubGlobal('fetch', fn);
    const { onApplied, onForked } = renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'huh');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));

    await screen.findByText('Instruction is too vague');
    // Never entered the preview state — still shows "Preview changes", not "Apply changes".
    expect(screen.getByRole('button', { name: /preview changes/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply changes/i })).not.toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    expect(onForked).not.toHaveBeenCalled();
  });

  it('shows a generic network error when the plan request throws', async () => {
    const fn = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/edit-agent/plan')) {
        return Promise.reject(new Error('network down'));
      }
      throw new Error('apply should not be called');
    });
    vi.stubGlobal('fetch', fn);
    renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'do it');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));

    await screen.findByText('Could not reach the edit agent. Please try again.');
    expect(screen.getByRole('button', { name: /preview changes/i })).toBeInTheDocument();
  });

  it('silently cancels a declined fork confirmation, keeping the preview intact', async () => {
    mockFetch(PRECISE_PLAN, { kind: 'forkConfirm' });
    const { onApplied, onForked } = renderPanel();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Edit instruction'), 'remove required from free text');
    await user.click(screen.getByRole('button', { name: /preview changes/i }));
    await screen.findByText('Make free-text optional');

    await user.click(screen.getByRole('button', { name: /apply changes/i }));

    // No `ForkConfirmProvider` is mounted, so the confirmation resolves declined: nothing was
    // written, no error banner, and the preview is still on screen for the admin to retry.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /apply changes/i })).not.toBeDisabled()
    );
    expect(screen.getByText('Make free-text optional')).toBeInTheDocument();
    expect(
      screen.queryByText('Edit cancelled — no new version was created.')
    ).not.toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
    expect(onForked).not.toHaveBeenCalled();
  });
});
