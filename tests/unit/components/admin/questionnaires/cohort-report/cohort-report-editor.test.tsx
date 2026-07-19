/**
 * CohortReportEditor — section list identity under reordering (F14.5).
 *
 * The point of these tests is the React key. Sections were keyed by array index while the row
 * offers Move up / Move down and carries a per-row `<Input>`; with an index key React reuses the
 * same DOM node across a swap, so focus, selection, and any uncontrolled DOM state stay put while
 * the data underneath them moves — the admin's cursor lands on the wrong section. Keying by a
 * stable client-side id fixes that.
 *
 * A "did the array reorder" assertion passes under the buggy code too, so the discriminating test
 * is the node-identity one ("moves the section's DOM node with it"): it was confirmed to fail
 * against `key={i}` and pass against `key={section.id}`, with the other cases green either way.
 *
 * Tiptap needs a real editing surface, so `RichTextEditor` is stubbed to a plain textarea — these
 * tests are about list identity, not rich-text behaviour (covered by rich-text-editor's own tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/admin/questionnaires/cohort-report/rich-text-editor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="body" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

// `apiClient` is the external boundary (HTTP); APIClientError is the real class so the
// component's `instanceof` branch is exercised rather than stubbed away.
const { mockPatch, mockPost } = vi.hoisted(() => ({ mockPatch: vi.fn(), mockPost: vi.fn() }));
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiClient: { patch: mockPatch, post: mockPost } };
});

import { CohortReportEditor } from '@/components/admin/questionnaires/cohort-report/cohort-report-editor';
import { APIClientError } from '@/lib/api/client';
import type { CohortReportContent } from '@/lib/app/questionnaire/cohort-report';

beforeEach(() => {
  vi.clearAllMocks();
  // happy-dom does not implement window.prompt, so there is nothing for spyOn to wrap — stub it.
  vi.stubGlobal('prompt', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Set what the AI-assist instruction prompt returns for the next click. */
function promptReturns(value: string | null) {
  vi.stubGlobal('prompt', vi.fn().mockReturnValue(value));
}

const CONTENT: CohortReportContent = {
  summary: 'Overall summary',
  sections: [
    { heading: 'Alpha', body: '<p>a</p>', format: 'html', chartIds: [] },
    { heading: 'Beta', body: '<p>b</p>', format: 'html', chartIds: [] },
    { heading: 'Gamma', body: '<p>g</p>', format: 'html', chartIds: [] },
  ],
  charts: [],
  recommendations: ['Rec one'],
  actions: ['Action one'],
};

function renderEditor(over: { onSaved?: () => void; refineUrl?: string } = {}) {
  return render(
    <CohortReportEditor
      patchUrl="/api/v1/app/rounds/r1/cohort-report"
      body={{ versionId: 'v1' }}
      content={CONTENT}
      onSaved={over.onSaved ?? vi.fn()}
      onCancel={vi.fn()}
      {...(over.refineUrl ? { refineUrl: over.refineUrl } : {})}
    />
  );
}

/** The section heading inputs, in render order. */
function headings(): HTMLInputElement[] {
  return screen
    .getAllByRole('textbox')
    .filter((el): el is HTMLInputElement =>
      (el.getAttribute('aria-label') ?? '').startsWith('Section ')
    );
}

describe('CohortReportEditor — section ordering', () => {
  it('renders one heading input per section, in order', () => {
    renderEditor();
    expect(headings().map((i) => i.value)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('moves a section down when Move down is clicked', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getAllByRole('button', { name: 'Move down' })[0]);

    expect(headings().map((i) => i.value)).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('moves a section up when Move up is clicked', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getAllByRole('button', { name: 'Move up' })[2]);

    expect(headings().map((i) => i.value)).toEqual(['Alpha', 'Gamma', 'Beta']);
  });

  it("moves the section's DOM node with it rather than reusing the row in place", async () => {
    // THE regression guard, asserted on node identity because that is what the key controls.
    //
    // Stable id (correct): React reorders the children, so the very same <input> element that
    // held "Alpha" is now at index 1 — any focus, selection, or uncontrolled DOM state on it
    // travels with the section.
    //
    // Index key (the bug): keys 0,1,2 are unchanged by a swap, so React keeps both nodes where
    // they are and just rewrites their props — the element that held "Alpha" stays at index 0
    // and now reads "Beta". `after[1]` would be a different node and this assertion fails.
    const user = userEvent.setup();
    renderEditor();

    const alphaNode = headings()[0];
    expect(alphaNode.value).toBe('Alpha');

    await user.click(screen.getAllByRole('button', { name: 'Move down' })[0]);

    const after = headings();
    expect(after.map((i) => i.value)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(after[1]).toBe(alphaNode);
    expect(after[0]).not.toBe(alphaNode);
  });

  it('disables Move up on the first row and Move down on the last', () => {
    renderEditor();
    expect(screen.getAllByRole('button', { name: 'Move up' })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Move down' })[2]).toBeDisabled();
  });
});

describe('CohortReportEditor — add / duplicate / remove', () => {
  it('appends a new section', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /add section/i }));

    expect(headings().map((i) => i.value)).toEqual(['Alpha', 'Beta', 'Gamma', 'New section']);
  });

  it('inserts a duplicate directly after its source', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getAllByRole('button', { name: 'Duplicate' })[0]);

    expect(headings().map((i) => i.value)).toEqual(['Alpha', 'Alpha', 'Beta', 'Gamma']);
  });

  it('gives a duplicate its own identity, so editing the copy leaves the original alone', async () => {
    // Both rows start with the same heading text; only a distinct key keeps them independent.
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getAllByRole('button', { name: 'Duplicate' })[0]);
    const copy = headings()[1];
    await user.clear(copy);
    await user.type(copy, 'Alpha (revised)');

    expect(headings().map((i) => i.value)).toEqual(['Alpha', 'Alpha (revised)', 'Beta', 'Gamma']);
  });

  it('removes the clicked section', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getAllByRole('button', { name: 'Delete section' })[1]);

    expect(headings().map((i) => i.value)).toEqual(['Alpha', 'Gamma']);
  });
});

describe('CohortReportEditor — save', () => {
  it('PATCHes the assembled content and hands the returned view to onSaved', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const view = { id: 'cr1' };
    mockPatch.mockResolvedValue(view);

    renderEditor({ onSaved });
    await user.click(screen.getByRole('button', { name: /save edits/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(view));

    const [url, opts] = mockPatch.mock.calls[0];
    expect(url).toBe('/api/v1/app/rounds/r1/cohort-report');
    // `body` (the owner discriminator) is merged alongside the content, not nested inside it.
    expect(opts.body.versionId).toBe('v1');
    expect(opts.body.content.summary).toBe('Overall summary');
    expect(opts.body.content.sections.map((s: { heading: string }) => s.heading)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('strips the client-side section id from the saved payload', async () => {
    // `id` is a render key only — persisting it would leak a client concern into stored content.
    const user = userEvent.setup();
    mockPatch.mockResolvedValue({});

    renderEditor();
    await user.click(screen.getByRole('button', { name: /save edits/i }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    for (const section of mockPatch.mock.calls[0][1].body.content.sections) {
      expect(section).not.toHaveProperty('id');
    }
  });

  it('splits recommendations and actions on newlines, dropping blank lines', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue({});

    renderEditor();
    const recs = screen.getByLabelText(/recommendations/i);
    await user.clear(recs);
    await user.type(recs, 'One{Enter}{Enter}  Two  ');
    await user.click(screen.getByRole('button', { name: /save edits/i }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(mockPatch.mock.calls[0][1].body.content.recommendations).toEqual(['One', 'Two']);
  });

  it('surfaces the API message on a failed save and does not call onSaved', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mockPatch.mockRejectedValue(new APIClientError('Version is not editable', 'CONFLICT', 409));

    renderEditor({ onSaved });
    await user.click(screen.getByRole('button', { name: /save edits/i }));

    expect(await screen.findByText('Version is not editable')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the failure is not an APIClientError', async () => {
    const user = userEvent.setup();
    mockPatch.mockRejectedValue(new Error('socket hang up'));

    renderEditor();
    await user.click(screen.getByRole('button', { name: /save edits/i }));

    // A raw network error must not be shown verbatim to an admin.
    expect(await screen.findByText('Failed to save the report.')).toBeInTheDocument();
    expect(screen.queryByText(/socket hang up/)).not.toBeInTheDocument();
  });

  it('re-enables the save button after a failure so the admin can retry', async () => {
    const user = userEvent.setup();
    mockPatch.mockRejectedValue(new Error('boom'));

    renderEditor();
    const save = screen.getByRole('button', { name: /save edits/i });
    await user.click(save);

    await screen.findByText('Failed to save the report.');
    expect(save).not.toBeDisabled();
  });
});

describe('CohortReportEditor — AI assist', () => {
  const REFINE = '/api/v1/app/rounds/r1/cohort-report/refine';

  it('hides the AI assist affordance when no refine endpoint is supplied', () => {
    renderEditor();
    expect(screen.queryByRole('button', { name: 'AI assist' })).not.toBeInTheDocument();
  });

  it('sends the section and instruction, then applies the refined result to that section', async () => {
    const user = userEvent.setup();
    promptReturns('Make it punchier');
    mockPost.mockResolvedValue({ heading: 'Alpha refined', body: '<p>new</p>' });

    renderEditor({ refineUrl: REFINE });
    await user.click(screen.getAllByRole('button', { name: 'AI assist' })[0]);

    await waitFor(() => expect(headings()[0].value).toBe('Alpha refined'));
    const [url, opts] = mockPost.mock.calls[0];
    expect(url).toBe(REFINE);
    expect(opts.body).toEqual({
      heading: 'Alpha',
      body: '<p>a</p>',
      instruction: 'Make it punchier',
    });
    // Only the targeted section changes.
    expect(headings().map((i) => i.value)).toEqual(['Alpha refined', 'Beta', 'Gamma']);
  });

  it('does nothing when the admin dismisses the prompt', async () => {
    const user = userEvent.setup();
    promptReturns(null);

    renderEditor({ refineUrl: REFINE });
    await user.click(screen.getAllByRole('button', { name: 'AI assist' })[0]);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('does nothing when the instruction is only whitespace', async () => {
    const user = userEvent.setup();
    promptReturns('   ');

    renderEditor({ refineUrl: REFINE });
    await user.click(screen.getAllByRole('button', { name: 'AI assist' })[0]);

    expect(mockPost).not.toHaveBeenCalled();
  });

  it('surfaces a refine failure and leaves the section untouched', async () => {
    const user = userEvent.setup();
    promptReturns('Rewrite');
    mockPost.mockRejectedValue(new Error('upstream down'));

    renderEditor({ refineUrl: REFINE });
    await user.click(screen.getAllByRole('button', { name: 'AI assist' })[0]);

    expect(await screen.findByText('AI assist failed.')).toBeInTheDocument();
    expect(headings()[0].value).toBe('Alpha');
  });
});
