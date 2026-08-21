/**
 * InterviewerStrategyPanel component tests.
 *
 * Anti-green-bar: drives the panel the way an admin does (enable → change approach → change pace →
 * switch opening mode → add/edit/remove examples) and asserts the rendered DOM and the `onChange`
 * payload, never mock internals.
 *
 * The highest-value assertions here are the ones on the **arc explainer**. Its whole reason for
 * existing is to answer "how quickly does this narrow?", so the tests pin that its numbers track the
 * selected pace and come from `FUNNEL_PACE_PROFILES` — a hard-coded table on screen that silently
 * disagreed with the runtime would be worse than the vague prose it replaced.
 *
 * The panel is controlled, so each harness re-renders with whatever `onChange` last emitted;
 * otherwise the assertions would only ever pin the first edit.
 *
 * @see components/admin/questionnaires/interviewer-strategy-panel.tsx
 */

import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InterviewerStrategyPanel } from '@/components/admin/questionnaires/interviewer-strategy-panel';
import { FUNNEL_PACE_PROFILES } from '@/lib/app/questionnaire/chat/interviewer-strategy';
import {
  DEFAULT_INTERVIEWER_STRATEGY,
  MAX_OPENING_EXAMPLES,
  OPENING_EXAMPLE_MAX,
  type InterviewerStrategySettings,
} from '@/lib/app/questionnaire/types';

const ON: InterviewerStrategySettings = { ...DEFAULT_INTERVIEWER_STRATEGY, enabled: true };

function renderPanel(initial: InterviewerStrategySettings = DEFAULT_INTERVIEWER_STRATEGY) {
  const onChange = vi.fn();
  let current = initial;

  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <InterviewerStrategyPanel
        value={value}
        onChange={(next) => {
          onChange(next);
          current = next;
          setValue(next);
        }}
      />
    );
  }

  render(<Harness />);
  return { onChange, latest: () => current };
}

/** Pick an option from one of the panel's selects by its accessible name. */
async function choose(selectName: string, optionLabel: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: selectName }));
  await user.click(await screen.findByRole('option', { name: optionLabel }));
}

describe('InterviewerStrategyPanel — the off state', () => {
  it('shows only the master switch until the override is turned on', () => {
    renderPanel({ ...DEFAULT_INTERVIEWER_STRATEGY, enabled: false });
    expect(
      screen.getByRole('switch', { name: 'Override the default questioning approach' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Approach' })).not.toBeInTheDocument();
    expect(screen.queryByText('How this plays out')).not.toBeInTheDocument();
  });

  it('turning it on preserves every other stored field', async () => {
    const stored: InterviewerStrategySettings = {
      ...DEFAULT_INTERVIEWER_STRATEGY,
      enabled: false,
      pace: 'brisk',
      openingMode: 'examples',
      openingExamples: ['Tell me about your week.'],
    };
    const { latest } = renderPanel(stored);
    await userEvent.setup().click(screen.getByRole('switch', { name: /Override the default/ }));
    expect(latest()).toEqual({ ...stored, enabled: true });
  });
});

describe('InterviewerStrategyPanel — pace', () => {
  it('offers the pace dial for the funnel only', async () => {
    renderPanel(ON);
    expect(screen.getByRole('combobox', { name: 'Pace' })).toBeInTheDocument();

    await choose('Approach', 'Open throughout');
    expect(screen.queryByRole('combobox', { name: 'Pace' })).not.toBeInTheDocument();

    await choose('Approach', 'Targeted / efficient');
    expect(screen.queryByRole('combobox', { name: 'Pace' })).not.toBeInTheDocument();
  });

  it('stores the chosen pace', async () => {
    const { latest } = renderPanel(ON);
    await choose('Pace', 'Narrow quickly');
    expect(latest().pace).toBe('brisk');
  });

  /**
   * The load-bearing UI assertion: the explainer's numbers are DERIVED from the same profile table
   * the prompt builder reads, so changing the dial visibly changes the bands. A hard-coded table
   * would pass a naive "renders 40%" test while lying about a brisk arc.
   */
  it('the arc explainer tracks the selected pace', async () => {
    // Rounded, exactly as the component does: `0.55 * 100` is 55.00000000000001 in IEEE floats, so
    // an unrounded percentage would render "55.00000000000001% covered" to the admin.
    const asPct = (fraction: number) => Math.round(fraction * 100);

    renderPanel(ON);
    const balanced = FUNNEL_PACE_PROFILES.balanced;
    expect(screen.getByText(`Up to ${asPct(balanced.openBelow)}% covered`)).toBeInTheDocument();
    expect(screen.getByText(`Over ${asPct(balanced.targetedAbove)}% covered`)).toBeInTheDocument();
    expect(screen.getByText(`First ${balanced.openingWindow} questions`)).toBeInTheDocument();

    await choose('Pace', 'Narrow quickly');
    const brisk = FUNNEL_PACE_PROFILES.brisk;
    expect(screen.getByText(`Up to ${asPct(brisk.openBelow)}% covered`)).toBeInTheDocument();
    expect(screen.getByText(`Over ${asPct(brisk.targetedAbove)}% covered`)).toBeInTheDocument();
    // Brisk's window is one ask — the count must read as singular, not "1 questions".
    expect(screen.getByText('First 1 question')).toBeInTheDocument();
    expect(
      screen.queryByText(`Up to ${asPct(balanced.openBelow)}% covered`)
    ).not.toBeInTheDocument();
  });

  it('never renders a floating-point artefact in a percentage', async () => {
    // Regression guard for the above: brisk's 0.55 is the value that exposes it.
    renderPanel(ON);
    await choose('Pace', 'Narrow quickly');
    expect(screen.queryByText(/\d+\.\d+%/)).not.toBeInTheDocument();
  });

  it('explains the round fallback and the terse bias for the funnel', () => {
    renderPanel(ON);
    expect(screen.getByText(/Short answers move it on one band sooner/)).toBeInTheDocument();
    expect(screen.getByText(/no coverage to read, so it counts questions/)).toBeInTheDocument();
  });

  /**
   * `funnelPhase` compares `questionsAsked` — the count ALREADY asked — so `>= targetedRounds`
   * first holds when the next ask is question `targetedRounds + 1`. Reading the profile number
   * straight out is off by one, and this footnote is the one line in the explainer that is not a
   * verbatim read of `FUNNEL_PACE_PROFILES` — exactly the drift the explainer exists to prevent.
   */
  it('states the round fallback boundaries as the reader counts questions', () => {
    renderPanel(ON);
    const balanced = FUNNEL_PACE_PROFILES.balanced;
    expect(
      screen.getByText(
        new RegExp(
          `open for the first ${balanced.openRounds}, specific from question ${balanced.targetedRounds + 1}`
        )
      )
    ).toBeInTheDocument();
  });

  it('shows a two-band explainer for Open throughout and none at all for Targeted', async () => {
    renderPanel(ON);
    await choose('Approach', 'Open throughout');
    expect(screen.getByText('How this plays out')).toBeInTheDocument();
    expect(screen.getByText('After that')).toBeInTheDocument();
    // No coverage bands: `open` never narrows, so quoting a switch-over point would be wrong.
    expect(screen.queryByText(/covered$/)).not.toBeInTheDocument();

    await choose('Approach', 'Targeted / efficient');
    expect(screen.queryByText('How this plays out')).not.toBeInTheDocument();
  });

  /** Mirrors `paceProfile()`, which reads `balanced` for any approach other than funnel. */
  it('an Open questionnaire shows the balanced window whatever pace is stored', async () => {
    renderPanel({ ...ON, pace: 'brisk' });
    await choose('Approach', 'Open throughout');
    expect(
      screen.getByText(`First ${FUNNEL_PACE_PROFILES.balanced.openingWindow} questions`)
    ).toBeInTheDocument();
  });
});

describe('InterviewerStrategyPanel — opening questions', () => {
  it('offers the mode picker for funnel and open, but not targeted', async () => {
    renderPanel(ON);
    const group = () => screen.queryByRole('radiogroup', { name: /opening question/i });
    expect(group()).toBeInTheDocument();

    await choose('Approach', 'Open throughout');
    expect(group()).toBeInTheDocument();

    await choose('Approach', 'Targeted / efficient');
    expect(group()).not.toBeInTheDocument();
  });

  it('defaults to letting the interviewer choose, and reveals the list on switching', async () => {
    const { latest } = renderPanel(ON);
    expect(screen.getByRole('radio', { name: /Let the interviewer choose/ })).toBeChecked();
    expect(screen.queryByRole('button', { name: /Add an example/ })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('radio', { name: /Guide it with examples/ }));
    expect(latest().openingMode).toBe('examples');
    expect(screen.getByRole('button', { name: /Add an example/ })).toBeInTheDocument();
  });

  it('adds, edits and removes examples', async () => {
    const user = userEvent.setup();
    const { latest } = renderPanel({ ...ON, openingMode: 'examples' });

    await user.click(screen.getByRole('button', { name: /Add an example/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Example opening question 1' }),
      'Tell me about your week.'
    );
    expect(latest().openingExamples).toEqual(['Tell me about your week.']);

    await user.click(screen.getByRole('button', { name: /Add an example/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Example opening question 2' }),
      'What stands out?'
    );
    expect(latest().openingExamples).toEqual(['Tell me about your week.', 'What stands out?']);

    await user.click(screen.getByRole('button', { name: 'Remove example 1' }));
    expect(latest().openingExamples).toEqual(['What stands out?']);
  });

  it('caps the list and says how many are used', async () => {
    const full = Array.from({ length: MAX_OPENING_EXAMPLES }, (_, i) => `Question ${i}`);
    renderPanel({ ...ON, openingMode: 'examples', openingExamples: full });
    expect(screen.getByText(`${MAX_OPENING_EXAMPLES} of ${MAX_OPENING_EXAMPLES}`)).toBeVisible();
    expect(screen.getByRole('button', { name: /Add an example/ })).toBeDisabled();
  });

  it('bounds each example to the stored maximum', () => {
    renderPanel({ ...ON, openingMode: 'examples', openingExamples: [''] });
    expect(screen.getByRole('textbox', { name: 'Example opening question 1' })).toHaveAttribute(
      'maxlength',
      String(OPENING_EXAMPLE_MAX)
    );
  });

  /**
   * The mode is on but inert. `usesGuidedOpening()` is what the runtime checks, and the warning has
   * to agree with it — otherwise the admin believes they have steered the opening when they have not.
   */
  it('warns while guided openings are switched on with nothing usable written', async () => {
    const user = userEvent.setup();
    const warning = /will still choose its own opening/;
    renderPanel({ ...ON, openingMode: 'examples' });
    expect(screen.getByText(warning)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Add an example/ }));
    // A blank row is not an example.
    expect(screen.getByText(warning)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Example opening question 1' }), '   ');
    expect(screen.getByText(warning)).toBeInTheDocument();

    await user.type(
      screen.getByRole('textbox', { name: 'Example opening question 1' }),
      'Tell me.'
    );
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });

  it('keeps written examples when the mode is switched back to auto', async () => {
    const { latest } = renderPanel({
      ...ON,
      openingMode: 'examples',
      openingExamples: ['Tell me about your week.'],
    });
    await userEvent
      .setup()
      .click(screen.getByRole('radio', { name: /Let the interviewer choose/ }));
    // Parking the mode must not discard the wording — drafting and shipping are different decisions.
    expect(latest().openingExamples).toEqual(['Tell me about your week.']);
  });
});

describe('InterviewerStrategyPanel — the suggester', () => {
  /** Suggestions the mocked route returns, so the accept path can be driven end to end. */
  const PROPOSED = 'Tell me about your experience of working here.';

  function mockSuggestFetch() {
    const fn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        success: true,
        data: { suggestions: [{ text: PROPOSED, why: 'Wide and easy.' }] },
      }),
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  afterEach(() => vi.unstubAllGlobals());

  /**
   * The ids are optional so the panel still renders standalone and in tests. Without them the AI
   * affordance is simply absent — every other control must still work.
   */
  it('is absent without the route ids, and present with them', () => {
    const value = { ...ON, openingMode: 'examples' as const, openingExamples: ['Tell me.'] };
    const { unmount } = render(<InterviewerStrategyPanel value={value} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Suggest openers/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add an example/ })).toBeInTheDocument();
    unmount();

    render(
      <InterviewerStrategyPanel
        value={value}
        onChange={vi.fn()}
        questionnaireId="qn-1"
        versionId="v1"
      />
    );
    expect(screen.getByRole('button', { name: /Suggest openers/ })).toBeInTheDocument();
  });

  it('appends an accepted suggestion to the list', async () => {
    mockSuggestFetch();
    const user = userEvent.setup();
    const onChange = vi.fn();
    let current: InterviewerStrategySettings = {
      ...ON,
      openingMode: 'examples',
      openingExamples: ['Tell me about your week.'],
    };

    function Harness() {
      const [value, setValue] = useState(current);
      return (
        <InterviewerStrategyPanel
          value={value}
          onChange={(next) => {
            onChange(next);
            current = next;
            setValue(next);
          }}
          questionnaireId="qn-1"
          versionId="v1"
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /Suggest openers/ }));
    await user.click(await screen.findByRole('button', { name: /^Add$/ }));
    expect(current.openingExamples).toEqual(['Tell me about your week.', PROPOSED]);
  });

  /**
   * An admin who clicked "Add an example" and then opened the assistant would otherwise be left
   * with an empty row above the accepted opener — which makes the list read as unfinished and
   * trips the panel's own "nothing written yet" warning.
   */
  it('fills a blank row rather than appending below it', async () => {
    mockSuggestFetch();
    const user = userEvent.setup();
    let current: InterviewerStrategySettings = {
      ...ON,
      openingMode: 'examples',
      openingExamples: [''],
    };

    function Harness() {
      const [value, setValue] = useState(current);
      return (
        <InterviewerStrategyPanel
          value={value}
          onChange={(next) => {
            current = next;
            setValue(next);
          }}
          questionnaireId="qn-1"
          versionId="v1"
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /Suggest openers/ }));
    await user.click(await screen.findByRole('button', { name: /^Add$/ }));
    expect(current.openingExamples).toEqual([PROPOSED]);
  });

  /**
   * The cap counts ROWS, but a blank row is capacity an accepted suggestion can use without growing
   * the list. Clicking "Add an example" at four written openers reaches five rows, one blank — and
   * a cap the dialog reads off the row count alone would disable every Add button while the blank
   * row it was meant to fill sits there, which is precisely the case the blank-fill exists for.
   */
  it('still accepts a proposal into a blank row when the list is at its row cap', async () => {
    mockSuggestFetch();
    const user = userEvent.setup();
    const written = Array.from({ length: MAX_OPENING_EXAMPLES - 1 }, (_, i) => `Question ${i}`);
    let current: InterviewerStrategySettings = {
      ...ON,
      openingMode: 'examples',
      openingExamples: [...written, ''],
    };

    function Harness() {
      const [value, setValue] = useState(current);
      return (
        <InterviewerStrategyPanel
          value={value}
          onChange={(next) => {
            current = next;
            setValue(next);
          }}
          questionnaireId="qn-1"
          versionId="v1"
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /Suggest openers/ }));
    const add = await screen.findByRole('button', { name: /^Add$/ });
    expect(add).toBeEnabled();
    await user.click(add);
    // Filled in place — still at the cap, no sixth row.
    expect(current.openingExamples).toEqual([...written, PROPOSED]);
  });

  it('offers nothing to add once every row is full', async () => {
    mockSuggestFetch();
    const user = userEvent.setup();
    const full = Array.from({ length: MAX_OPENING_EXAMPLES }, (_, i) => `Question ${i}`);
    render(
      <InterviewerStrategyPanel
        value={{ ...ON, openingMode: 'examples', openingExamples: full }}
        onChange={vi.fn()}
        questionnaireId="qn-1"
        versionId="v1"
      />
    );

    await user.click(screen.getByRole('button', { name: /Suggest openers/ }));
    // Readable, but genuinely full — there is no blank row for the proposal to land in.
    expect(await screen.findByRole('button', { name: /^Add$/ })).toBeDisabled();
  });

  it('tells the dialog which openers are already in the list', async () => {
    mockSuggestFetch();
    const user = userEvent.setup();
    render(
      <InterviewerStrategyPanel
        value={{ ...ON, openingMode: 'examples', openingExamples: [PROPOSED] }}
        onChange={vi.fn()}
        questionnaireId="qn-1"
        versionId="v1"
      />
    );

    await user.click(screen.getByRole('button', { name: /Suggest openers/ }));
    // Shown as already added rather than offered a second time.
    expect(await screen.findByRole('button', { name: /Added/ })).toBeDisabled();
  });
});

describe('InterviewerStrategyPanel — tactics', () => {
  it('toggles each tactic independently', async () => {
    const user = userEvent.setup();
    const { latest } = renderPanel(ON);

    await user.click(screen.getByRole('switch', { name: 'Reflect and confirm' }));
    expect(latest()).toMatchObject({ reflect: true, probeDepth: true, batchRelated: true });

    await user.click(screen.getByRole('switch', { name: 'Probe for depth' }));
    expect(latest()).toMatchObject({ reflect: true, probeDepth: false, batchRelated: true });

    // The third tactic is the one the title promises and nothing else reaches — the panel is the
    // only surface that writes it, so an unwired switch here would ship silently.
    await user.click(screen.getByRole('switch', { name: 'Batch related questions' }));
    expect(latest()).toMatchObject({ reflect: true, probeDepth: false, batchRelated: false });
  });
});

describe('InterviewerStrategyPanel — disabled', () => {
  it('locks every control while a save is in flight', () => {
    // Only the disabled panel is mounted, so every query below is singular and cannot be satisfied
    // by the wrong tree — an enabled sibling would make `getAllByRole(...).at(-1)` the real assertion.
    render(
      <InterviewerStrategyPanel
        value={{ ...ON, openingMode: 'examples', openingExamples: ['Tell me.'] }}
        onChange={vi.fn()}
        disabled
      />
    );
    expect(screen.getByRole('button', { name: /Add an example/ })).toBeDisabled();
    expect(
      screen.getByRole('switch', { name: 'Override the default questioning approach' })
    ).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Batch related questions' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Approach' })).toBeDisabled();
  });
});
