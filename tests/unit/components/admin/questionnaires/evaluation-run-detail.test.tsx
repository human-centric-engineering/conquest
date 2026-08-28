// @vitest-environment happy-dom

/**
 * Component test: the F5.3 review queue (`EvaluationRunDetail` + `FindingReviewCard`).
 *
 * Anti-green-bar: asserts the card calls the review/apply endpoints with the right method + body
 * (not merely that a mock returned), that Apply is disabled when a finding is stale or apply is
 * off, and that a successful action updates the card from the server response.
 *
 * The detail view defaults to **by question** with every group collapsed, so `renderQueue` switches
 * to the by-judge view: the tests in the first block are about the finding *card*, which renders
 * identically in both views, and judge view shows it without an expand step. The second block
 * (`by-question view`) covers the default view itself — collapse behaviour, grouping, sorting,
 * filters, and that review actions still work from there.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EvaluationRunDetail } from '@/components/admin/questionnaires/evaluation-run-detail';
import { QUESTION_FACE } from '@/components/admin/questionnaires/evaluation-field';
import type {
  EvaluationFindingView,
  EvaluationRunDetail as EvaluationRunDetailView,
} from '@/lib/app/questionnaire/views';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function finding(over: Partial<EvaluationFindingView> = {}): EvaluationFindingView {
  return {
    id: 'f1',
    dimension: 'duplicates',
    ordinal: 0,
    targetKey: 'q_dupe',
    target: null,
    severity: 'minor',
    proposedChange: 'Remove the duplicate question.',
    rationale: 'Same as q_role.',
    sourceQuote: null,
    status: 'pending',
    proposedEdit: { op: 'delete_question' },
    editedOverride: null,
    applyInstruction: null,
    decidedByUserId: null,
    decidedAt: null,
    appliedAt: null,
    appliedToVersionId: null,
    stale: false,
    applicable: 'apply',
    ...over,
  };
}

function run(findings: EvaluationFindingView[]): EvaluationRunDetailView {
  return {
    id: 'run1',
    status: 'completed',
    dimensionsRequested: 7,
    dimensionsRun: 7,
    dimensionsFailed: 0,
    totalFindings: findings.length,
    dimensionSummary: [
      { dimension: 'duplicates', score: 0.8, findingCount: findings.length, diagnostic: null },
    ],
    reconciled: [],
    triggeredByUserId: null,
    startedAt: '2026-06-05T00:00:00.000Z',
    completedAt: '2026-06-05T00:00:01.000Z',
    createdAt: '2026-06-05T00:00:01.000Z',
    versionId: 'v1',
    questionnaireId: 'qn1',
    error: null,
    findings,
  };
}

async function renderQueue(
  findings: EvaluationFindingView[],
  canApply = true,
  dataSlotsAvailable = false
) {
  const result = render(
    <EvaluationRunDetail
      run={run(findings)}
      questionnaireId="qn1"
      versionId="v1"
      canApply={canApply}
      dataSlotsAvailable={dataSlotsAvailable}
    />
  );
  // These exercise the finding card itself, which renders identically in both views. Judge view
  // shows it without a collapse step; the by-question block below covers the default view.
  await switchToJudgeView();
  return result;
}

/**
 * Scope a query to the finding cards.
 *
 * The filter row carries `<select>`s whose options spell the same words the cards do ("Accepted",
 * "Major"), so an unscoped `getByText('Accepted')` matches the filter as well as the badge. Queries
 * about a finding go through here.
 */
function inFindings() {
  return within(screen.getAllByRole('list')[0]);
}

/** Switch the detail view to the per-judge grouping (the original F5.2/F5.3 default). */
async function switchToJudgeView() {
  await userEvent.click(screen.getByRole('button', { name: 'By judge' }));
}

/**
 * Open a question group in the by-question view — every group starts collapsed, so the page opens
 * as an index of which questions have problems rather than a wall of findings.
 */
async function expandGroup(match: RegExp) {
  await userEvent.click(screen.getByRole('button', { name: match }));
}

/**
 * Matches a paragraph of judge prose across the element boundary the quoted-wording treatment
 * introduces.
 *
 * A suggestion like `Define "recommend".` renders as `Define <q>recommend</q>.` — one fixture
 * string, three DOM nodes — so an exact-string query misses it. The quotation marks come from the
 * UA stylesheet rather than the text, so they are absent from `textContent` too. Scoped to `<p>`
 * so an ancestor card is not matched instead.
 */
function prose(text: string) {
  const flattened = text.replace(/["“”]/g, '');
  return (_content: string, el: Element | null) =>
    el?.tagName === 'P' && el.textContent?.replace(/\s+/g, ' ').trim() === flattened;
}

const Q_ROLE = /What is your role and tenure\?/;
const Q_NPS = /Would you recommend us\?/;

function addQuestionFinding(over: Partial<EvaluationFindingView> = {}): EvaluationFindingView {
  // Keep dimension = 'duplicates' so it renders under the test run's single dimension summary.
  return finding({
    applicable: 'deep-link',
    proposedEdit: { op: 'add_question', prompt: 'How big is your team?', type: 'free_text' },
    ...over,
  });
}

function mockFetchOnce(data: unknown, meta?: unknown) {
  (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ success: true, data, meta }),
  });
}

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('EvaluationRunDetail review queue', () => {
  it('renders the finding with its proposed change and op summary', async () => {
    await renderQueue([finding()]);
    expect(screen.getByText('Remove the duplicate question.')).toBeInTheDocument();
    expect(screen.getByText(/Removes this question from the questionnaire/)).toBeInTheDocument();
  });

  it('names the question a judgement is about, with its section and position', async () => {
    await renderQueue([
      finding({
        target: {
          kind: 'question',
          key: 'q_dupe',
          label: 'What is your role?',
          sectionTitle: 'Background',
          position: 2,
          sectionPosition: 1,
          questionType: 'likert',
          removed: false,
        },
      }),
    ]);
    expect(screen.getByText('“What is your role?”')).toBeInTheDocument();
    expect(screen.getByText('Question 2 · Background')).toBeInTheDocument();
  });

  it('keeps the questionnaire, the advice and the reasoning separable without an eyebrow on each', async () => {
    // Three near-identical paragraphs otherwise: the question, the suggestion, the reasoning.
    // The question is separated by face, the reasoning by colour, and only the block that would
    // genuinely be misread as prose — a quote the judge is citing — still carries a label.
    await renderQueue([
      finding({
        sourceQuote: 'Guidelines: skip if the respondent is a contractor.',
        target: {
          kind: 'question',
          key: 'q_dupe',
          label: 'What is your role?',
          sectionTitle: 'Background',
          position: 2,
          sectionPosition: 1,
          questionType: 'likert',
          removed: false,
        },
      }),
    ]);
    expect(screen.getByText('Question 2 · Background')).toBeInTheDocument();
    // The questionnaire's own words, in the questionnaire's own face.
    expect(screen.getByText('“What is your role?”').className).toContain(QUESTION_FACE);
    expect(screen.getByText('Remove the duplicate question.')).toBeInTheDocument();
    expect(screen.getByText('Same as q_role.')).toBeInTheDocument();
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    // What applying would do, as a caption on the buttons rather than a labelled section.
    expect(screen.getByText(/Removes this question from the questionnaire/)).toBeInTheDocument();
    // The eyebrows the card used to stack down its left edge are gone.
    expect(screen.queryByText('Suggestion')).not.toBeInTheDocument();
    expect(screen.queryByText('Rationale')).not.toBeInTheDocument();
  });

  it('labels a section target as a section rather than a question', async () => {
    await renderQueue([
      finding({
        targetKey: 'section:Background',
        target: {
          kind: 'section',
          key: 'section:Background',
          label: 'Background',
          sectionTitle: 'Background',
          position: null,
          sectionPosition: 1,
          questionType: null,
          removed: false,
        },
      }),
    ]);
    expect(screen.getByText('Section')).toBeInTheDocument();
    // Not quoted — a section title is not something a respondent is asked.
    expect(screen.getByText('Background')).toBeInTheDocument();
  });

  it('names the answer type, so the reader can judge a suggestion without opening the editor', async () => {
    await renderQueue([
      finding({
        target: {
          kind: 'question',
          key: 'q_dupe',
          label: 'What is your role?',
          sectionTitle: 'Background',
          position: 2,
          sectionPosition: 1,
          questionType: 'single_choice',
          removed: false,
        },
      }),
    ]);
    expect(screen.getByText('Multi-Choice (One Answer)')).toBeInTheDocument();
  });

  it('drops a source quote that only restates the question already shown above it', async () => {
    // Judges routinely quote the prompt verbatim as their evidence. Rendering it again, indented,
    // reads as a further detail when it is the same sentence — so it is suppressed, not shown.
    await renderQueue([
      finding({
        sourceQuote: 'What is your role?',
        target: {
          kind: 'question',
          key: 'q_dupe',
          label: 'What is your role?',
          sectionTitle: 'Background',
          position: 2,
          sectionPosition: 1,
          questionType: 'free_text',
          removed: false,
        },
      }),
    ]);
    // The prompt is named once — as the target line, not a second time as a quote.
    expect(screen.getAllByText(/What is your role\?/)).toHaveLength(1);
  });

  it('keeps a source quote that points outside the question prompt', async () => {
    await renderQueue([
      finding({
        sourceQuote: 'Guidelines: skip if the respondent is a contractor.',
        target: {
          kind: 'question',
          key: 'q_dupe',
          label: 'What is your role?',
          sectionTitle: 'Background',
          position: 2,
          sectionPosition: 1,
          questionType: 'free_text',
          removed: false,
        },
      }),
    ]);
    expect(
      screen.getByText('Guidelines: skip if the respondent is a contractor.')
    ).toBeInTheDocument();
  });

  it('marks a target that was removed from the structure since the run', async () => {
    await renderQueue([
      finding({
        target: {
          kind: 'question',
          key: 'q_dupe',
          label: 'What is your role?',
          sectionTitle: 'Background',
          position: 1,
          sectionPosition: 1,
          questionType: 'likert',
          removed: true,
        },
      }),
    ]);
    expect(screen.getByText('removed since this run')).toBeInTheDocument();
  });

  it('falls back to the raw key chip when the target could not be resolved', async () => {
    await renderQueue([finding({ target: null })]);
    expect(screen.getByText('q_dupe')).toBeInTheDocument();
    expect(screen.getByText('Target')).toBeInTheDocument();
  });

  it('labels a version-level goal finding without quoting it as a question', async () => {
    await renderQueue([
      finding({
        targetKey: 'goal',
        target: {
          kind: 'goal',
          key: 'goal',
          label: 'Questionnaire goal',
          sectionTitle: null,
          position: null,
          sectionPosition: null,
          questionType: null,
          removed: false,
        },
      }),
    ]);
    // The context chip names it. The header's named-target block is suppressed for goal/audience:
    // their label only restates the kind, so rendering it would print "goal" three ways over.
    expect(screen.getByText('Goal')).toBeInTheDocument();
    expect(screen.queryByText('“Questionnaire goal”')).not.toBeInTheDocument();
  });

  it('dismiss calls the PATCH review endpoint and updates the card', async () => {
    await renderQueue([finding()]);
    mockFetchOnce(finding({ status: 'declined' }));

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ action: 'decline' }),
      })
    );
    await waitFor(() => expect(inFindings().getByText('Declined')).toBeInTheDocument());
  });

  it('apply calls the apply endpoint and shows a fork banner when the response forks', async () => {
    await renderQueue([finding()]);
    mockFetchOnce(
      { finding: finding({ status: 'applied', appliedToVersionId: 'v2' }) },
      {
        forked: true,
        versionId: 'v2',
        versionNumber: 2,
      }
    );

    await userEvent.click(screen.getByRole('button', { name: 'Apply this change' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1/apply',
      expect.objectContaining({ method: 'POST' })
    );
    await waitFor(() => expect(screen.getByText(/new draft/i)).toBeInTheDocument());
  });

  it('disables Apply when the finding is stale', async () => {
    await renderQueue([finding({ stale: true })]);
    expect(screen.getByRole('button', { name: 'Apply this change' })).toBeDisabled();
  });

  it('disables Apply when apply is off (canApply=false)', async () => {
    await renderQueue([finding()], false);
    expect(screen.getByRole('button', { name: 'Apply this change' })).toBeDisabled();
  });

  it('offers one-click "Add to questionnaire" + a seeded "Open in editor" link for an add_question', async () => {
    await renderQueue([
      finding({
        applicable: 'deep-link',
        proposedEdit: { op: 'add_question', prompt: 'How big is your team?', type: 'free_text' },
      }),
    ]);
    // Not the generic "Apply" — a question-specific primary action, plus the drafted prompt preview.
    expect(screen.queryByRole('button', { name: 'Apply this change' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to questionnaire' })).toBeInTheDocument();
    expect(screen.getByText('How big is your team?')).toBeInTheDocument();
    // The editor link carries the finding ref so the editor can pre-fill the composer.
    const link = screen.getByRole('link', { name: /open in editor/i });
    expect(link.getAttribute('href')).toContain('seedFinding=run1%3Af1');
  });

  it('"Add to questionnaire" calls the apply endpoint and updates the card on success', async () => {
    await renderQueue([
      finding({
        applicable: 'deep-link',
        proposedEdit: { op: 'add_question', prompt: 'New?', type: 'free_text' },
      }),
    ]);
    mockFetchOnce({ finding: finding({ status: 'applied', appliedToVersionId: 'v1' }) });

    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1/apply',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('offers exactly two ways out of a finding: do it, or dismiss it', async () => {
    // Four verbs — accept, dismiss, edit, apply — is three too many when two of them are English
    // near-synonyms that do opposite things. "Accept" was the one with no consequence: applying
    // already records agreement, and the fork-lineage rule that made batch-agree-then-apply worth
    // having is enforced server-side, not by the admin sequencing their clicks.
    await renderQueue([addQuestionFinding()]);
    expect(screen.getByRole('button', { name: 'Add to questionnaire' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('captions the drafted prompt so it cannot be read as an existing question', async () => {
    // The draft renders in the same weight as `proposedChange` right above it; without the caption
    // a question that does not exist yet looks like one that does.
    await renderQueue([addQuestionFinding()]);
    expect(screen.getByText(/Suggested new question · Free text/)).toBeInTheDocument();
    expect(screen.getByText('How big is your team?')).toBeInTheDocument();
  });

  it('names the new question as the subject of the data-slot checkbox', async () => {
    // Under a coverage-gap heading, a bare "add to a data slot" reads as slotting the *heading*.
    await renderQueue([addQuestionFinding()], true, true);
    expect(screen.getByLabelText(/Also add the new question to a data slot/i)).toBeInTheDocument();
  });

  it('disables "Add to questionnaire" when the add_question finding is stale', async () => {
    await renderQueue([
      finding({
        applicable: 'deep-link',
        stale: true,
        proposedEdit: { op: 'add_question', prompt: 'New?', type: 'free_text' },
      }),
    ]);
    expect(screen.getByRole('button', { name: 'Add to questionnaire' })).toBeDisabled();
  });

  it('shows the data-slot checkbox for an add_question only when the version has data slots', async () => {
    const { unmount } = await renderQueue([addQuestionFinding()], true, false);
    expect(screen.queryByLabelText(/to a data slot/i)).not.toBeInTheDocument();
    unmount();
    await renderQueue([addQuestionFinding()], true, true);
    expect(screen.getByLabelText(/to a data slot/i)).toBeChecked();
  });

  it('assigns the new question to a data slot after a one-click add when the checkbox is on', async () => {
    await renderQueue([addQuestionFinding()], true, true);
    // Apply response (the finding, now applied to v1) then the follow-up assign call.
    mockFetchOnce({ finding: addQuestionFinding({ status: 'applied', appliedToVersionId: 'v1' }) });
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { slots: [], assigned: 1, created: 0 } }),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/app/questionnaires/qn1/versions/v1/data-slots/assign',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  it('does not assign after a one-click add when the data-slot checkbox is unticked', async () => {
    await renderQueue([addQuestionFinding()], true, true);
    await userEvent.click(screen.getByLabelText(/to a data slot/i)); // untick
    mockFetchOnce({ finding: addQuestionFinding({ status: 'applied', appliedToVersionId: 'v1' }) });

    await userEvent.click(screen.getByRole('button', { name: 'Add to questionnaire' }));

    await waitFor(() => expect(screen.getByText(/Applied to/)).toBeInTheDocument());
    const calledAssign = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/data-slots/assign')
    );
    expect(calledAssign).toBe(false);
  });

  it('filters findings by status', async () => {
    await renderQueue([
      finding({ id: 'f1', status: 'pending' }),
      finding({ id: 'f2', status: 'applied' }),
    ]);
    // Both visible under "all".
    expect(screen.getAllByText('Remove the duplicate question.')).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'applied');
    await waitFor(() =>
      expect(screen.getAllByText('Remove the duplicate question.')).toHaveLength(1)
    );
  });

  it('keeps the verdict describing the panel when a filter narrows the findings', async () => {
    // The band reports what the *panel* said, so it must survive the filter row. Deriving it from
    // the filtered set let a filter manufacture the consensus `group-actions` exists never to
    // manufacture: narrow to Major here and the band would read "Delete this question · 1 judge"
    // with no dissent — telling the reviewer the panel agreed, and hiding the rewording.
    render(
      <EvaluationRunDetail
        run={run([
          finding({
            id: 'f1',
            dimension: 'duplicates',
            severity: 'major',
            proposedChange: 'Remove the duplicate question.',
            proposedEdit: { op: 'delete_question' },
          }),
          finding({
            id: 'f2',
            dimension: 'clarity',
            severity: 'minor',
            proposedChange: 'Reword the double-barrelled ask.',
            proposedEdit: { op: 'replace_prompt', prompt: 'How engaged do you feel?' },
          }),
        ])}
        questionnaireId="qn1"
        versionId="v1"
        canApply
        dataSlotsAvailable={false}
      />
    );

    await expandGroup(/q_dupe/);

    // Unfiltered: both proposed actions have a block, each naming its own backing.
    expect(screen.getByText('A deletion, as proposed by 1 of 2 judges')).toBeInTheDocument();
    expect(screen.getByText('A reword, as proposed by 1 of 2 judges')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'major');

    // The clarity finding is filtered out of the tabs below, but the verdict is unchanged — the
    // rewording proposal must not vanish just because the reviewer narrowed what they are reading.
    await waitFor(() =>
      expect(screen.getByText('A reword, as proposed by 1 of 2 judges')).toBeInTheDocument()
    );
    expect(screen.getByText('A deletion, as proposed by 1 of 2 judges')).toBeInTheDocument();
  });

  it('heads each of the two actions with what it does, not just what it is called', async () => {
    // A button label alone cannot answer "what happens if I click this", and a tooltip only
    // answers it for someone already hovering. Both sections say it in visible copy.
    await renderQueue([finding()]);
    expect(screen.getByText('Change the questionnaire now')).toBeInTheDocument();
    expect(screen.getByText(/Removes this question from the questionnaire/)).toBeInTheDocument();
    expect(screen.getByText('Or dismiss it')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Rejects this suggestion and marks it decided\. Nothing in the questionnaire/
      )
    ).toBeInTheDocument();
  });

  it('Dismiss records a decision without touching the questionnaire', async () => {
    await renderQueue([finding()]);
    mockFetchOnce(finding({ status: 'declined' }));

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    // The distinction that matters: Dismiss hits the review route, never the apply route.
    const urls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(urls).toContain(
      '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1'
    );
    expect(urls.some((u) => typeof u === 'string' && u.endsWith('/apply'))).toBe(false);
  });

  it('dismiss calls PATCH with { action: "decline" }', async () => {
    await renderQueue([finding()]);
    mockFetchOnce(finding({ status: 'declined' }));
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/findings/f1'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ action: 'decline' }) })
    );
  });

  it('surfaces an error when the action fails', async () => {
    await renderQueue([finding()]);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        success: false,
        error: { message: 'Boom', details: { reason: 'stale' } },
      }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.getByText(/Boom \(stale\)/)).toBeInTheDocument());
  });

  it('edit opens a typed form and saves an override via PATCH edit', async () => {
    await renderQueue([finding({ proposedEdit: { op: 'replace_prompt', prompt: 'Old prompt' } })]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    const textarea = screen.getByRole('textbox');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'New prompt');

    mockFetchOnce(finding({ editedOverride: { op: 'replace_prompt', prompt: 'New prompt' } }));
    await userEvent.click(screen.getByRole('button', { name: 'Save edit' }));

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/findings/f1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          action: 'edit',
          editedOverride: { op: 'replace_prompt', prompt: 'New prompt' },
        }),
      })
    );
  });

  it('renders a change_type op summary and a type select in its edit form', async () => {
    await renderQueue([finding({ proposedEdit: { op: 'change_type', type: 'single_choice' } })]);
    // The filter row carries its own selects, so scope to the finding card: the combobox under
    // test is the edit form's type picker, not "Status" or "Severity".
    expect(screen.getByText(/Changes the answer type/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    expect(inFindings().getByRole('combobox')).toBeInTheDocument();
  });

  it('dims a terminal (applied) finding and offers no actions', async () => {
    await renderQueue([finding({ status: 'applied', appliedToVersionId: 'v2' })]);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply this change' })).not.toBeInTheDocument();
    expect(screen.getByText(/Applied to/)).toBeInTheDocument();
  });

  it('renders a manual finding with an editor link and no Apply', async () => {
    await renderQueue([finding({ applicable: 'manual', proposedEdit: null })]);
    expect(screen.queryByRole('button', { name: 'Apply this change' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open in editor/i })).toBeInTheDocument();
  });

  it('renders a failed dimension as a failure — reason, raw code, and a retry — not a score', async () => {
    const r = run([]);
    r.dimensionSummary = [
      { dimension: 'duplicates', score: null, findingCount: 0, diagnostic: 'judge_not_configured' },
    ];
    render(<EvaluationRunDetail run={r} questionnaireId="qn1" versionId="v1" canApply />);
    await switchToJudgeView();

    // The diagnostic code is translated for the admin...
    expect(screen.getAllByText(/no agent configured/i).length).toBeGreaterThan(0);
    // ...but stays reachable for support, on the element carrying the reason.
    expect(document.querySelector('[title="judge_not_configured"]')).toBeInTheDocument();
    // Both the headline strip and the judge section offer the way out.
    expect(screen.getAllByRole('button', { name: 'Retry judge' })).toHaveLength(2);
  });

  it('shows "No issues raised" for a clean dimension', async () => {
    render(<EvaluationRunDetail run={run([])} questionnaireId="qn1" versionId="v1" canApply />);
    await switchToJudgeView();
    expect(screen.getByText('No issues raised.')).toBeInTheDocument();
  });

  it('renders the source quote and a stale badge', async () => {
    await renderQueue([finding({ sourceQuote: 'the offending phrase', stale: true })]);
    expect(screen.getByText('the offending phrase')).toBeInTheDocument();
    expect(screen.getByText(/Stale — re-run/)).toBeInTheDocument();
  });

  it('marks an op as edited when an override is present', async () => {
    await renderQueue([
      finding({
        proposedEdit: { op: 'replace_prompt', prompt: 'a' },
        editedOverride: { op: 'delete_question' },
      }),
    ]);
    expect(screen.getByText(/\(your edited version\)/)).toBeInTheDocument();
    // The effective op is the override (delete).
    expect(screen.getByText(/Removes this question from the questionnaire/)).toBeInTheDocument();
  });

  it('describes edit_guidelines (set vs clear)', async () => {
    const { unmount } = await renderQueue([
      finding({ proposedEdit: { op: 'edit_guidelines', guidelines: 'Be concrete.' } }),
    ]);
    expect(screen.getByText(/Sets the author guidelines/)).toBeInTheDocument();
    unmount();
    await renderQueue([finding({ proposedEdit: { op: 'edit_guidelines', guidelines: null } })]);
    expect(screen.getByText(/Clears the author guidelines/)).toBeInTheDocument();
  });

  it('describes reorder with and without a target section', async () => {
    const { unmount } = await renderQueue([
      finding({ proposedEdit: { op: 'reorder', ordinal: 2 } }),
    ]);
    expect(screen.getByText(/Moves this question to position 3/)).toBeInTheDocument();
    unmount();
    await renderQueue([
      finding({ proposedEdit: { op: 'reorder', ordinal: 0, targetSectionKey: 'Intro' } }),
    ]);
    expect(screen.getByText(/Moves this question into .*Intro.*at position 1/)).toBeInTheDocument();
  });

  it('describes edit_audience and offers no inline Edit (not an inline-editable op)', async () => {
    await renderQueue([
      finding({
        targetKey: 'audience',
        proposedEdit: { op: 'edit_audience', audience: { role: 'x' } },
      }),
    ]);
    expect(screen.getByText(/Updates the audience description \(role\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit first' })).not.toBeInTheDocument();
  });

  it('saves an edited goal via the reorder/goal text form', async () => {
    await renderQueue([
      finding({ targetKey: 'goal', proposedEdit: { op: 'edit_goal', goal: 'Old goal' } }),
    ]);
    expect(screen.getByText(/Replaces the questionnaire's goal statement/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    const textarea = screen.getByRole('textbox');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Sharper goal');
    mockFetchOnce(finding());
    await userEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/findings/f1'),
      expect.objectContaining({
        body: JSON.stringify({
          action: 'edit',
          editedOverride: { op: 'edit_goal', goal: 'Sharper goal' },
        }),
      })
    );
  });

  it('edits a reorder ordinal via the number input', async () => {
    await renderQueue([finding({ proposedEdit: { op: 'reorder', ordinal: 1 } })]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    const numberInput = screen.getByRole('spinbutton');
    await userEvent.clear(numberInput);
    await userEvent.type(numberInput, '4');
    mockFetchOnce(finding());
    await userEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/findings/f1'),
      expect.objectContaining({
        body: JSON.stringify({ action: 'edit', editedOverride: { op: 'reorder', ordinal: 4 } }),
      })
    );
  });

  it('disables Save edit when the required text is emptied, and Cancel closes the form', async () => {
    await renderQueue([finding({ proposedEdit: { op: 'replace_prompt', prompt: 'Some prompt' } })]);
    await userEvent.click(screen.getByRole('button', { name: 'Edit first' }));
    await userEvent.clear(screen.getByRole('textbox'));
    expect(screen.getByRole('button', { name: 'Save edit' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Save edit' })).not.toBeInTheDocument();
  });
});

/** Two judges flagging the same question — the case the by-judge view cannot express. */
function crossJudgeRun(): EvaluationRunDetailView {
  const findings = [
    finding({
      id: 'f1',
      dimension: 'clarity',
      targetKey: 'q_role',
      severity: 'major',
      proposedChange: 'Split the double-barrelled question.',
      target: {
        kind: 'question',
        key: 'q_role',
        label: 'What is your role and tenure?',
        sectionTitle: 'Background',
        position: 1,
        sectionPosition: 1,
        questionType: 'likert',
        removed: false,
      },
    }),
    finding({
      id: 'f2',
      dimension: 'type_fit',
      targetKey: 'q_role',
      severity: 'minor',
      proposedChange: 'Free text suits this better.',
      target: {
        kind: 'question',
        key: 'q_role',
        label: 'What is your role and tenure?',
        sectionTitle: 'Background',
        position: 1,
        sectionPosition: 1,
        questionType: 'likert',
        removed: false,
      },
    }),
    // q_nps sits *later* in the questionnaire but carries *more* majors, so the three sort
    // orders genuinely disagree about it — which is what makes the ordering test meaningful.
    finding({
      id: 'f3',
      dimension: 'clarity',
      targetKey: 'q_nps',
      severity: 'info',
      proposedChange: 'Define "recommend".',
      target: npsTarget(),
    }),
    finding({
      id: 'f4',
      dimension: 'ordering',
      targetKey: 'q_nps',
      severity: 'major',
      proposedChange: 'Move this after the context questions.',
      target: npsTarget(),
    }),
    finding({
      id: 'f5',
      dimension: 'coverage',
      targetKey: 'q_nps',
      severity: 'major',
      proposedChange: 'Ask why, not just whether.',
      target: npsTarget(),
    }),
  ];
  const r = run(findings);
  r.dimensionSummary = [
    { dimension: 'clarity', score: 0.6, findingCount: 2, diagnostic: null },
    { dimension: 'type_fit', score: 0.9, findingCount: 1, diagnostic: null },
    { dimension: 'ordering', score: 0.5, findingCount: 1, diagnostic: null },
    { dimension: 'coverage', score: 0.4, findingCount: 1, diagnostic: null },
  ];
  return r;
}

/**
 * A run where the `ordering` judge failed — the undercount case. Its findings come out with it:
 * a judge that never returned a verdict raised nothing, which is exactly why the totals lie.
 */
function failedJudgeRun(): EvaluationRunDetailView {
  const r = crossJudgeRun();
  r.findings = r.findings.filter((f) => f.dimension !== 'ordering');
  r.totalFindings = r.findings.length;
  r.status = 'partial';
  r.dimensionsRun = 6;
  r.dimensionsFailed = 1;
  r.dimensionSummary = r.dimensionSummary.map((d) =>
    d.dimension === 'ordering'
      ? {
          dimension: 'ordering' as const,
          score: null,
          findingCount: 0,
          diagnostic: 'dispatch_error',
        }
      : d
  );
  return r;
}

/** A run whose contested `q_role` came back with two reconciled wordings. */
function reconciledRun(): EvaluationRunDetailView {
  const r = crossJudgeRun();
  r.reconciled = [
    {
      targetKey: 'q_role',
      alternatives: [
        {
          prompt: 'What is your current role?',
          addresses: ['clarity', 'type_fit'],
          note: 'One ask, and free text fits it.',
        },
        {
          prompt: 'What do you do here?',
          addresses: ['clarity'],
          note: 'Shorter, but loses the seniority signal.',
        },
      ],
      unresolved: ['ordering'],
    },
  ];
  return r;
}

function npsTarget() {
  return {
    kind: 'question' as const,
    key: 'q_nps',
    label: 'Would you recommend us?',
    sectionTitle: 'Outcomes',
    position: 1,
    sectionPosition: 2,
    questionType: 'likert',
    removed: false,
  };
}

function renderCrossJudge() {
  return render(
    <EvaluationRunDetail
      run={crossJudgeRun()}
      questionnaireId="qn1"
      versionId="v1"
      canApply
      dataSlotsAvailable={false}
    />
  );
}

describe('EvaluationRunDetail by-question view', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('defaults to the by-question view', () => {
    renderCrossJudge();
    expect(screen.getByRole('button', { name: 'By question' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('starts collapsed on the question alone — no verdict, no judgements', () => {
    renderCrossJudge();
    // Both questions are listed, each with how bad it is...
    expect(screen.getByText('“What is your role and tenure?”')).toBeInTheDocument();
    expect(screen.getByText('“Would you recommend us?”')).toBeInTheDocument();
    expect(screen.getByText('1 major')).toBeInTheDocument();
    // ...and nothing else. The index is a list of questions to work through; what the panel
    // concluded and why are both one click away rather than stacked into the same column.
    expect(
      screen.queryByText('The overall verdict from the evaluation judges:')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Split the double-barrelled question.')).not.toBeInTheDocument();
    expect(screen.queryByText('Flagged by the following judges:')).not.toBeInTheDocument();
  });

  it('says on the closed card that the panel split, even though the verdict is hidden', async () => {
    // The one thing a collapsed card must not be able to hide. A reviewer skimming the queue
    // should never discover only after opening a card that a judge wanted the question deleted.
    render(
      <EvaluationRunDetail
        run={run([
          finding({ id: 'a1', dimension: 'clarity', proposedEdit: { op: 'delete_question' } }),
          finding({
            id: 'a2',
            dimension: 'ordering',
            proposedEdit: { op: 'replace_prompt', prompt: 'Sharper?' },
          }),
        ])}
        questionnaireId="qn1"
        versionId="v1"
        canApply
      />
    );
    expect(screen.getByText('Judges disagree')).toBeInTheDocument();
  });

  it('names the actions on the table once the card is open', async () => {
    // The verb is the point: the reviewer should learn "this one is a deletion, backed by both
    // judges" from a heading, not by reading two suggestions and inferring it.
    renderCrossJudge();
    await expandGroup(Q_ROLE);
    expect(screen.getByText('The overall verdict from the evaluation judges:')).toBeInTheDocument();
    expect(screen.getByText('A deletion, as proposed by all 2 judges')).toBeInTheDocument();
  });

  it('shows the reconciled wording with the verdict, above the judgements that produced it', async () => {
    // The whole reason the reconcile step exists: a reviewer should reach the wording several
    // judges can live with without reading four competing rewrites to synthesise it themselves.
    render(
      <EvaluationRunDetail
        run={reconciledRun()}
        questionnaireId="qn1"
        versionId="v1"
        canApply
        dataSlotsAvailable={false}
      />
    );

    // Closed, none of it is on screen.
    expect(screen.queryByText('“What is your current role?”')).not.toBeInTheDocument();

    await expandGroup(Q_ROLE);
    expect(screen.getByText('“What is your current role?”')).toBeInTheDocument();
    expect(screen.getByText(/Satisfies Clarity, Type-Fit/)).toBeInTheDocument();
  });

  it('says which judge the rewrite cannot satisfy, rather than implying it satisfies all', async () => {
    // A rewrite offered as the answer to an ordering complaint would be a lie about the panel.
    render(
      <EvaluationRunDetail
        run={reconciledRun()}
        questionnaireId="qn1"
        versionId="v1"
        canApply
        dataSlotsAvailable={false}
      />
    );

    await expandGroup(Q_ROLE);
    // Phrased as a fact about the wording, and printed inside the block holding that wording.
    // Floating at the end of the verdict it read as a free-standing finding about a judge.
    expect(
      screen.getByText(
        'No wording satisfies Ordering — that judge needs a structural change, not a rewrite.'
      )
    ).toBeInTheDocument();
  });

  it('shows every reconciled wording once the card is open', async () => {
    // The verdict now only renders on the open card, so there is no scanning state left to
    // protect from a second option — holding one back would just hide a trade-off the reviewer
    // has already asked to see.
    render(
      <EvaluationRunDetail
        run={reconciledRun()}
        questionnaireId="qn1"
        versionId="v1"
        canApply
        dataSlotsAvailable={false}
      />
    );
    expect(screen.queryByText('“What do you do here?”')).not.toBeInTheDocument();

    await expandGroup(Q_ROLE);
    expect(screen.getByText('“What is your current role?”')).toBeInTheDocument();
    expect(screen.getByText('“What do you do here?”')).toBeInTheDocument();
  });

  it('gives every proposed action its own block, so a deletion is never a footnote', async () => {
    // Two judges want the question reworded and one wants it deleted. Appended to the winner as a
    // trailing clause ("· 1 judge says delete this question instead"), the deletion read as an
    // aside about the reword rather than as the other thing on the table.
    const target = {
      kind: 'question' as const,
      key: 'q_role',
      label: 'What is your role and tenure?',
      sectionTitle: 'Background',
      position: 1,
      sectionPosition: 1,
      questionType: 'likert',
      removed: false,
    };
    const contested = run([
      finding({
        id: 'c1',
        dimension: 'clarity',
        targetKey: 'q_role',
        target,
        proposedEdit: { op: 'replace_prompt', prompt: 'What is your role?' },
      }),
      finding({
        id: 'c2',
        dimension: 'audience_match',
        targetKey: 'q_role',
        target,
        proposedEdit: { op: 'replace_prompt', prompt: 'What is your role?' },
      }),
      finding({
        id: 'c3',
        dimension: 'goal_match',
        targetKey: 'q_role',
        target,
        proposedEdit: { op: 'delete_question' },
      }),
    ]);

    render(
      <EvaluationRunDetail
        run={contested}
        questionnaireId="qn1"
        versionId="v1"
        canApply
        dataSlotsAvailable={false}
      />
    );

    expect(screen.getByText('Judges disagree')).toBeInTheDocument();

    await expandGroup(Q_ROLE);
    expect(screen.getByText('A reword, as proposed by 2 of 3 judges')).toBeInTheDocument();
    expect(screen.getByText('A deletion, as proposed by 1 of 3 judges')).toBeInTheDocument();
  });

  it('shows each question’s answer type on the collapsed index', async () => {
    renderCrossJudge();
    expect(screen.getAllByText('Likert').length).toBeGreaterThan(0);
  });

  it('heads drafted questions as coverage gaps, never as the questionnaire goal', async () => {
    // A gap is addressed at `goal` because a missing question has no key — but grouped under a
    // "Questionnaire goal" heading it reads as an edit to the goal, which it never is.
    render(
      <EvaluationRunDetail
        run={run([addQuestionFinding({ dimension: 'coverage', targetKey: 'goal' })])}
        questionnaireId="qn1"
        versionId="v1"
        canApply
        dataSlotsAvailable={false}
      />
    );
    expect(screen.getByText('Questions not yet asked')).toBeInTheDocument();
    expect(screen.getByText('Coverage gap')).toBeInTheDocument();
    expect(screen.queryByText('Questionnaire goal')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing here changes an existing question/)).toBeInTheDocument();
  });

  it('puts each judge behind its own tab, one judge’s reasoning at a time', async () => {
    // Stacked in one column, a question flagged by four judges was four near-identical cards each
    // with its own apply controls, and the reviewer scrolled past three to reach the fourth.
    renderCrossJudge();
    await expandGroup(Q_ROLE);

    // One heading for the question, even though two different judges flagged it.
    expect(screen.getAllByText('“What is your role and tenure?”')).toHaveLength(1);
    // Both judges are offered...
    expect(screen.getByText('Flagged by the following judges:')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Clarity' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Type-Fit' })).toHaveAttribute('aria-selected', 'false');
    // ...but only the selected one's judgement is on screen.
    expect(screen.getByText('Split the double-barrelled question.')).toBeInTheDocument();
    expect(screen.queryByText('Free text suits this better.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Type-Fit' }));
    await waitFor(() => {
      expect(screen.getByText('Free text suits this better.')).toBeInTheDocument();
      expect(screen.queryByText('Split the double-barrelled question.')).not.toBeInTheDocument();
    });
  });

  it('names the judge on the open card, since the group heading already names the question', async () => {
    renderCrossJudge();
    await expandGroup(Q_ROLE);
    // The visible judgement names its own judge...
    expect(screen.getByText('Clarity Judge')).toBeInTheDocument();
    // ...and does not repeat the question, which the group heading already carries.
    expect(screen.getAllByText('“What is your role and tenure?”')).toHaveLength(1);
  });

  it('opens one question at a time — expanding another closes the first', async () => {
    // These cards are tall when open. Two at once means scrolling past finished work to reach
    // unfinished work, so the group behaves as an accordion.
    renderCrossJudge();
    await expandGroup(Q_ROLE);
    expect(screen.getByText('Split the double-barrelled question.')).toBeInTheDocument();

    await expandGroup(Q_NPS);
    await waitFor(() => {
      expect(screen.getByText(prose('Define "recommend".'))).toBeInTheDocument();
      expect(screen.queryByText('Split the double-barrelled question.')).not.toBeInTheDocument();
    });
    // Exactly one verdict on screen is the accordion's whole guarantee.
    expect(screen.getAllByText('The overall verdict from the evaluation judges:')).toHaveLength(1);
  });

  it('closes the open question when its own header is clicked again', async () => {
    renderCrossJudge();
    await expandGroup(Q_ROLE);
    expect(screen.getByText('Split the double-barrelled question.')).toBeInTheDocument();

    await expandGroup(Q_ROLE);
    await waitFor(() =>
      expect(screen.queryByText('Split the double-barrelled question.')).not.toBeInTheDocument()
    );
  });

  it('sets the question under review apart from the prose about it', async () => {
    renderCrossJudge();

    // The card's subject is in the questionnaire's own face, and it is a heading — so a reviewer
    // scrolling a long open card can find *which question this is* without reading paragraphs.
    const heading = screen.getByRole('heading', { name: '“Would you recommend us?”' });
    expect(heading.className).toContain(QUESTION_FACE);

    // The disclosure sits inside the group's one filled surface — the header AREA, which also
    // carries the panel's verdict once open. That is what makes it read as a header rather than
    // as the first of several similar-looking blocks.
    const header = screen.getByRole('button', { name: Q_NPS });
    const headerArea = header.parentElement as HTMLElement;
    expect(headerArea.className).toMatch(/bg-muted/);

    // ...and the group itself is not a box around it. Nesting a tinted header inside a bordered
    // card inside the page flattens the very hierarchy the tint is expressing.
    const group = headerArea.parentElement as HTMLElement;
    expect(group.tagName).toBe('SECTION');
    expect(group.className).not.toMatch(/\bborder\b|\brounded-xl\b|\bbg-card\b/);
  });

  it('keeps the verdict flush with the question and indents only the individual judges', async () => {
    // The verdict is a property of the question above it, not a detail underneath it. Sharing the
    // indent with the judges made it read as the first of them rather than the summary of all.
    renderCrossJudge();
    await expandGroup(Q_NPS);

    const header = screen.getByRole('button', { name: Q_NPS });
    const headerArea = header.parentElement as HTMLElement;
    expect(headerArea.textContent).toContain('The overall verdict from the evaluation judges:');

    const group = headerArea.parentElement as HTMLElement;
    const judges = group.querySelector('div[class*="pl-"]') as HTMLElement;
    expect(judges).not.toBeNull();
    expect(judges.textContent).toContain('Flagged by the following judges:');
  });

  it('shows the severity tally per question', () => {
    renderCrossJudge();
    expect(screen.getByText('1 major')).toBeInTheDocument(); // q_role
    expect(screen.getByText('1 minor')).toBeInTheDocument(); // q_role
    expect(screen.getByText('2 major')).toBeInTheDocument(); // q_nps
  });

  // Ordering *logic* is covered exhaustively in group-findings.test.ts; this asserts only
  // that the control is wired to it — that changing the select re-orders the rendered cards.
  it('re-orders the cards when the sort control changes', async () => {
    renderCrossJudge();
    // Group headings are the quoted question prompts — the headline band also has an h3.
    const headings = () =>
      screen
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent)
        .filter((t) => t?.startsWith('“'));

    // Natural: section 1 (q_role) before section 2 (q_nps).
    expect(headings()).toEqual(['“What is your role and tenure?”', '“Would you recommend us?”']);

    // Worst-first flips them: q_nps has 2 majors to q_role's 1.
    await userEvent.selectOptions(screen.getByLabelText('Sort questions'), 'major');
    await waitFor(() =>
      expect(headings()).toEqual(['“Would you recommend us?”', '“What is your role and tenure?”'])
    );

    // Busiest-first also flips them: q_nps has 3 findings to q_role's 2.
    await userEvent.selectOptions(screen.getByLabelText('Sort questions'), 'findings');
    await waitFor(() =>
      expect(headings()).toEqual(['“Would you recommend us?”', '“What is your role and tenure?”'])
    );

    // ...and back, proving the control drives the order rather than the fixture doing so.
    await userEvent.selectOptions(screen.getByLabelText('Sort questions'), 'natural');
    await waitFor(() =>
      expect(headings()).toEqual(['“What is your role and tenure?”', '“Would you recommend us?”'])
    );
  });

  it('filters by severity across the whole run, not just the open question', async () => {
    renderCrossJudge();
    await expandGroup(Q_NPS);
    expect(screen.getByText(prose('Define "recommend".'))).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'major');

    await waitFor(() => {
      // The open question drops the info-severity judge entirely — tabs and all — and falls back
      // to the first judge still standing.
      expect(screen.getByText('Move this after the context questions.')).toBeInTheDocument();
      expect(screen.queryByText(prose('Define "recommend".'))).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Clarity' })).not.toBeInTheDocument();
    });

    // ...and the filter reached the closed question too, which still shows a major tally.
    await expandGroup(Q_ROLE);
    await waitFor(() => {
      expect(screen.getByText('Split the double-barrelled question.')).toBeInTheDocument();
      expect(screen.queryByText('Free text suits this better.')).not.toBeInTheDocument();
    });
  });

  it('filters to one judge when its headline cell is clicked', async () => {
    renderCrossJudge();
    await expandGroup(Q_ROLE);
    await userEvent.click(screen.getByRole('button', { name: 'Filter to Type-Fit Judge' }));
    await waitFor(() => {
      expect(screen.getByText('Free text suits this better.')).toBeInTheDocument();
      expect(screen.queryByText('Split the double-barrelled question.')).not.toBeInTheDocument();
    });
  });

  it('shows an empty state when the filters exclude everything', async () => {
    renderCrossJudge();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'declined');
    await waitFor(() =>
      expect(screen.getByText('No findings match these filters.')).toBeInTheDocument()
    );
  });

  it('keeps review actions working from the by-question view', async () => {
    renderCrossJudge();
    await expandGroup(Q_ROLE);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: finding({ id: 'f1', status: 'declined' }) }),
    });

    // The open tab is Clarity, whose finding on q_role is f1.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/findings/f1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ action: 'decline' }) })
    );
  });

  it('reports severity totals and review progress in the headline', () => {
    renderCrossJudge();
    // 3 majors across 2 flagged questions, and nothing reviewed yet.
    expect(screen.getByText('across 2 flagged items')).toBeInTheDocument();
    expect(screen.getByText('0 / 5')).toBeInTheDocument();
    expect(screen.getByText('5 still pending')).toBeInTheDocument();
  });

  it('gives each judge a severity split in the headline strip', () => {
    renderCrossJudge();
    // Clarity raised one major (q_role) and one info (q_nps).
    expect(screen.getByLabelText('Severity split: 1 major, 1 info')).toBeInTheDocument();
  });

  it('fills each severity segment from a distinct ramp step', () => {
    // The regression this guards: major and minor once used `destructive` and `--cq-accent`, which
    // measure ~10 ΔE apart, so a stacked bar read as one undifferentiated red band. The exact
    // hexes live in globals.css (documented with their measurements) — what must hold here is that
    // no two severities share a step, and that the segments are separated rather than butted.
    renderCrossJudge();
    const bar = screen.getByLabelText('Severity split: 1 major, 1 info');
    const fills = [...bar.children].map((c) => c.className);
    expect(fills).toHaveLength(2);
    expect(new Set(fills).size).toBe(2);
    expect(bar.className).toContain('gap-[2px]');
  });

  it('still lists a fully-decided question, and it reopens like any other', async () => {
    const r = crossJudgeRun();
    r.findings = r.findings.map((f) =>
      f.targetKey === 'q_nps' ? { ...f, status: 'declined' as const } : f
    );
    render(<EvaluationRunDetail run={r} questionnaireId="qn1" versionId="v1" canApply />);

    // Decided work is dimmed rather than dropped — it stays in the index...
    expect(screen.getByText('“Would you recommend us?”')).toBeInTheDocument();
    // ...and opens on click like any other group.
    await expandGroup(Q_NPS);
    await waitFor(() => expect(screen.getByText(prose('Define "recommend".'))).toBeInTheDocument());
  });

  it('opens groups independently — expanding one leaves the others folded', async () => {
    renderCrossJudge();
    await expandGroup(Q_NPS);
    expect(screen.getByText(prose('Define "recommend".'))).toBeInTheDocument();
    expect(screen.queryByText('Split the double-barrelled question.')).not.toBeInTheDocument();

    // And a group closes again on a second click.
    await expandGroup(Q_NPS);
    await waitFor(() =>
      expect(screen.queryByText(prose('Define "recommend".'))).not.toBeInTheDocument()
    );
  });

  it('warns that totals undercount when a judge failed to run', () => {
    render(
      <EvaluationRunDetail run={failedJudgeRun()} questionnaireId="qn1" versionId="v1" canApply />
    );
    expect(screen.getByText('1 judge did not run')).toBeInTheDocument();
    expect(screen.getByText(/severity totals above are an undercount/)).toBeInTheDocument();
    // The failure names itself rather than leaving a bare code, and offers its way out.
    expect(screen.getByText(/errored before it returned/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry judge' })).toBeInTheDocument();
  });
});

describe('EvaluationRunDetail judge retry', () => {
  /** The run the retry route returns: the same run with `ordering` now having a verdict. */
  function repairedRun(): EvaluationRunDetailView {
    const r = failedJudgeRun();
    return {
      ...r,
      status: 'completed',
      dimensionsRun: 7,
      dimensionsFailed: 0,
      dimensionSummary: r.dimensionSummary.map((d) =>
        d.dimension === 'ordering' ? { ...d, score: 0.75, findingCount: 0, diagnostic: null } : d
      ),
    };
  }

  it('re-runs the one failed judge against the retry endpoint', async () => {
    mockFetchOnce(repairedRun());
    render(
      <EvaluationRunDetail run={failedJudgeRun()} questionnaireId="qn1" versionId="v1" canApply />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry judge' }));

    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/v1/app/questionnaires/qn1/versions/v1/evaluations/run1/retry');
    expect(init.method).toBe('POST');
    // Only the failed judge is re-dispatched — not the whole panel.
    expect(JSON.parse(init.body as string)).toEqual({ dimension: 'ordering' });
  });

  it('swaps in the refreshed run, so the undercount warning clears', async () => {
    mockFetchOnce(repairedRun());
    render(
      <EvaluationRunDetail run={failedJudgeRun()} questionnaireId="qn1" versionId="v1" canApply />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry judge' }));

    await waitFor(() => expect(screen.queryByText('1 judge did not run')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry judge' })).not.toBeInTheDocument();
    // The judge now reads as a judge that ran.
    expect(screen.getByText('0.75')).toBeInTheDocument();
  });

  it('keeps the failure on screen and says why when the retry itself fails', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        success: false,
        error: { code: 'CONFLICT', message: 'That judge already returned a verdict' },
      }),
    });
    render(
      <EvaluationRunDetail run={failedJudgeRun()} questionnaireId="qn1" versionId="v1" canApply />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Retry judge' }));

    await waitFor(() =>
      expect(
        screen.getByText(/Retry failed: That judge already returned a verdict/)
      ).toBeInTheDocument()
    );
    // The run is untouched — the warning is still true.
    expect(screen.getByText('1 judge did not run')).toBeInTheDocument();
  });
});
