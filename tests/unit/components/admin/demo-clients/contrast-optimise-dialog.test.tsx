// @vitest-environment happy-dom

/**
 * ContrastOptimiseDialog component tests.
 *
 * The dialog's job is to make a contrast proposal JUDGEABLE, so the behaviours worth pinning are
 * the ones that decide whether an admin can trust it:
 *
 *  - it sends the theme it was handed — the admin's UNSAVED edits — because auditing the saved row
 *    would check colours they have already moved on from;
 *  - a clean theme is reported as a clean theme, not as an empty panel that reads as a broken
 *    feature;
 *  - proposals arrive pre-ticked and Apply hands the parent only the accepted ones, as plain values;
 *  - a proposal shows before AND after, because "does this pass" is not the question the admin is
 *    answering — "is this still their brand" is;
 *  - what no shade can fix is stated rather than hidden, or applying the rest looks like a fix;
 *  - the button counts FIELDS, not proposals, because the accent fails twice and moves once.
 *
 * @see components/admin/demo-clients/contrast-optimise-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ContrastOptimiseDialog } from '@/components/admin/demo-clients/contrast-optimise-dialog';
import type {
  ContrastProposal,
  OptimiseResult,
} from '@/lib/app/questionnaire/brand-contrast/result';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const THEME = { canvasColor: '#fffcf5', inkColor: '#9a9a8f' };

function proposal(over: Partial<ContrastProposal> = {}): ContrastProposal {
  return {
    finding: {
      pair: 'canvas-light',
      label: 'Body text on the page',
      ground: '#fffcf5',
      ink: '#9a9a8f',
      ratio: 2.77,
      target: 4.5,
      onDerivedValue: false,
    },
    repairs: [
      {
        field: 'inkColor',
        label: 'Ink colour',
        from: '#9a9a8f',
        current: '#9a9a8f',
        to: '#75756d',
        resultingGround: '#fffcf5',
        resultingInk: '#75756d',
        ratio: 4.53,
        amount: -0.24,
      },
    ],
    chosen: 0,
    rationale: 'The paper stock is what this brand is known by, so the text moves instead.',
    ...over,
  };
}

/** A second proposal that moves a DIFFERENT field, for the multi-accept cases. */
const BAND = proposal({
  finding: {
    pair: 'surface',
    label: 'The title on the header band',
    ground: '#767676',
    ink: '#1a1a1a',
    ratio: 3.83,
    target: 4.5,
    onDerivedValue: true,
  },
  repairs: [
    {
      field: 'surfaceColor',
      label: 'Surface colour',
      from: '#767676',
      current: '#767676',
      to: '#828282',
      resultingGround: '#828282',
      resultingInk: '#1a1a1a',
      ratio: 4.53,
      amount: 0.09,
    },
  ],
  rationale: 'The band carries the title, so lifting the band is the smaller move.',
});

function result(over: Partial<OptimiseResult> = {}): OptimiseResult {
  return {
    outcome: 'proposed',
    proposals: [proposal()],
    unfixable: [],
    degraded: false,
    summary: 'One pairing on the respondent surface is too low-contrast to read comfortably.',
    ...over,
  };
}

const CLEAN = result({
  outcome: 'clean',
  proposals: [],
  summary: 'Every colour pairing on the respondent surface clears WCAG AA. Nothing to change.',
});

function renderDialog(overrides: Partial<Parameters<typeof ContrastOptimiseDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onApply = vi.fn();
  const utils = render(
    <ContrastOptimiseDialog
      open
      onOpenChange={onOpenChange}
      theme={THEME}
      onApply={onApply}
      {...overrides}
    />
  );
  return { ...utils, onOpenChange, onApply };
}

const checkButton = () => screen.getByRole('button', { name: /check contrast|check again/i });

async function runCheck(user: ReturnType<typeof userEvent.setup>, data: OptimiseResult = result()) {
  mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data }));
  await user.click(checkButton());
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
}

describe('ContrastOptimiseDialog — the request', () => {
  it('offers nothing until the admin asks — no check runs on open', () => {
    renderDialog();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends the theme it was handed, which is the admin’s unsaved edit', async () => {
    const user = userEvent.setup();
    renderDialog();
    await runCheck(user);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).theme).toEqual(THEME);
  });

  it('passes the client id when there is one, for cost attribution', async () => {
    const user = userEvent.setup();
    renderDialog({ demoClientId: 'dc-1' });
    await runCheck(user);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).demoClientId).toBe('dc-1');
  });

  it('surfaces the server’s own message rather than flattening it', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'RATE_LIMITED', message: 'Slow down.' } }, 429)
    );
    const user = userEvent.setup();
    renderDialog();
    await user.click(checkButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Slow down.');
  });

  it('says something when the request throws outright', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderDialog();
    await user.click(checkButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  });
});

describe('ContrastOptimiseDialog — a theme that reads', () => {
  it('says so, rather than showing an empty panel', async () => {
    // An admin who presses the button and gets nothing back reads a broken feature, not a pass.
    const user = userEvent.setup();
    renderDialog();
    await runCheck(user, CLEAN);

    expect(await screen.findByText(/clears WCAG AA/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('leaves Apply disabled when there is nothing to apply', async () => {
    const user = userEvent.setup();
    renderDialog();
    await runCheck(user, CLEAN);

    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled();
  });
});

describe('ContrastOptimiseDialog — proposals', () => {
  it('pre-ticks every proposal — the admin vetoes, they do not re-select', async () => {
    const user = userEvent.setup();
    renderDialog();
    await runCheck(user, result({ proposals: [proposal(), BAND] }));

    for (const box of await screen.findAllByRole('checkbox')) {
      expect(box).toBeChecked();
    }
  });

  it('shows before and after, so the change is judgeable against what it replaces', async () => {
    const user = userEvent.setup();
    renderDialog();
    await runCheck(user);

    expect(await screen.findByText('2.8:1')).toBeInTheDocument();
    expect(screen.getByText('4.5:1')).toBeInTheDocument();
    expect(screen.getByText('#9a9a8f → #75756d')).toBeInTheDocument();
  });

  it('names the field the change lands in, using the form’s own label', async () => {
    const user = userEvent.setup();
    renderDialog();
    await runCheck(user);

    expect(await screen.findByText('Ink colour')).toBeInTheDocument();
  });

  it('says when a repair fills in a field the admin never set', async () => {
    const user = userEvent.setup();
    renderDialog();
    const unset = proposal();
    unset.repairs = [{ ...unset.repairs[0], from: null }];
    await runCheck(user, result({ proposals: [unset] }));

    expect(await screen.findByText(/currently unset/i)).toBeInTheDocument();
  });

  it('shows the rationale — the part that is actually advice', async () => {
    const user = userEvent.setup();
    renderDialog();
    await runCheck(user);

    expect(
      await screen.findByText(/the paper stock is what this brand is known by/i)
    ).toBeInTheDocument();
  });
});

describe('ContrastOptimiseDialog — applying', () => {
  it('hands the parent the accepted repairs as plain field values, then closes', async () => {
    const user = userEvent.setup();
    const { onApply, onOpenChange } = renderDialog();
    await runCheck(user, result({ proposals: [proposal(), BAND] }));

    await user.click(await screen.findByRole('button', { name: /^Apply/ }));

    expect(onApply).toHaveBeenCalledWith({ inkColor: '#75756d', surfaceColor: '#828282' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('drops a vetoed proposal from what Apply sends', async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    await runCheck(user, result({ proposals: [proposal(), BAND] }));

    await user.click(await screen.findByRole('checkbox', { name: /The title on the header band/ }));
    await user.click(screen.getByRole('button', { name: /^Apply/ }));

    expect(onApply).toHaveBeenCalledWith({ inkColor: '#75756d' });
  });

  it('applies the CHOSEN repair, not the first one', async () => {
    // The chosen index is the adviser's judgement. Applying `repairs[0]` regardless would silently
    // discard it while still showing its rationale.
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    const twoWays = proposal();
    twoWays.repairs = [
      twoWays.repairs[0],
      {
        field: 'canvasColor',
        label: 'Canvas colour',
        from: '#fffcf5',
        current: '#fffcf5',
        to: '#333231',
        resultingGround: '#333231',
        resultingInk: '#9a9a8f',
        ratio: 4.5,
        amount: -0.8,
      },
    ];
    twoWays.chosen = 1;
    await runCheck(user, result({ proposals: [twoWays] }));

    await user.click(await screen.findByRole('button', { name: /^Apply/ }));

    expect(onApply).toHaveBeenCalledWith({ canvasColor: '#333231' });
  });

  it('counts fields rather than proposals, because the accent fails twice and moves once', async () => {
    // Both accent findings are repaired by shading one colour — solved against both grounds, so
    // the two repairs carry the same value. "Apply 2 changes" for one moved field overstates it.
    const user = userEvent.setup();
    renderDialog();
    const light = proposal({
      finding: {
        pair: 'accent-light',
        label: 'Links and highlights on the page',
        ground: '#ffffff',
        ink: '#00e5ff',
        ratio: 1.54,
        target: 3,
        onDerivedValue: true,
      },
      repairs: [
        {
          field: 'accentColor',
          label: 'Accent colour',
          from: '#00e5ff',
          current: '#00e5ff',
          to: '#00a4b6',
          resultingGround: '#ffffff',
          resultingInk: '#00a4b6',
          ratio: 3.01,
          amount: -0.29,
        },
      ],
    });
    const dark = proposal({ ...light, finding: { ...light.finding, pair: 'accent-dark' } });
    await runCheck(user, result({ proposals: [light, dark] }));

    expect(await screen.findByRole('button', { name: 'Apply 1 change' })).toBeInTheDocument();
  });
});

describe('ContrastOptimiseDialog — what it cannot fix, and what it did not consider', () => {
  it('states an unfixable pairing instead of hiding it', async () => {
    // Omitting it would let the admin apply the rest and believe the theme is now readable.
    const user = userEvent.setup();
    renderDialog();
    await runCheck(
      user,
      result({
        unfixable: [
          {
            pair: 'accent-dark',
            label: 'Links and highlights in dark mode',
            ground: '#0a0a0a',
            ink: '#0a1a3a',
            ratio: 1.15,
            target: 3,
            onDerivedValue: true,
          },
        ],
      })
    );

    expect(
      await screen.findByText(/Needs a different colour, not a different shade/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Links and highlights in dark mode/)).toBeInTheDocument();
  });

  it('shows the summary’s degraded note, so a ranked pick is not mistaken for a considered one', async () => {
    const user = userEvent.setup();
    renderDialog();
    await runCheck(
      user,
      result({
        degraded: true,
        summary:
          'One pairing is too low-contrast. No AI adviser was available, so these are the smallest changes that work.',
      })
    );

    expect(await screen.findByText(/no ai adviser was available/i)).toBeInTheDocument();
  });
});
