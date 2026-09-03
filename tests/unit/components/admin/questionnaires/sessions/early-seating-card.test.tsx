// @vitest-environment happy-dom

/**
 * EarlySeatingCard — what the interview committed to before it had a plan (F17.36 phase 5).
 *
 * Anti-green-bar: each assertion below is a claim about the interview that would be WRONG if the
 * panel collapsed it into the plan panel beside it:
 *
 *  - a session that never reached a plan still decided something, and the panel must say so
 *    differently from one whose plan absorbed the same areas;
 *  - what the RESPONDENT was told is a separate sentence from the reason the admin was given, and a
 *    challenge is usually about the gap between them;
 *  - areas the caps judged warranted and never took are part of the record, because a cap that
 *    quietly discards decisions reads afterwards as "it only found one area".
 *
 * @see components/admin/questionnaires/sessions/early-seating-card.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EarlySeatingCard } from '@/components/admin/questionnaires/sessions/early-seating-card';
import type { AdminEarlySeatingView } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';

function seat(over: Partial<AdminEarlySeatingView['seated'][number]> = {}) {
  return {
    key: 'talent',
    label: 'Talent & hiring',
    atTurn: 3,
    confidence: 0.92,
    rationale: 'They said the team doubled.',
    respondentReason: 'You mentioned the team has doubled this year.',
    ...over,
  };
}

function view(over: Partial<AdminEarlySeatingView> = {}): AdminEarlySeatingView {
  return { seated: [seat()], deferred: [], overCap: false, ...over };
}

describe('EarlySeatingCard', () => {
  it('names the turn each area came into scope on, which no other surface still holds', () => {
    // A sealed plan stamps ONE decision turn over everything it absorbed, so "chosen at turn 3 and
    // the rest at turn 9" survives only here.
    render(<EarlySeatingCard early={view()} planned={true} />);
    expect(screen.getByText('turn 3')).toBeInTheDocument();
    expect(screen.getByText('92% sure')).toBeInTheDocument();
  });

  it('keeps what the respondent was told beside the reason the admin was given', () => {
    render(<EarlySeatingCard early={view()} planned={false} />);
    expect(screen.getByText('They said the team doubled.')).toBeInTheDocument();
    expect(screen.getByText(/You mentioned the team has doubled this year\./)).toBeInTheDocument();
  });

  it('reads differently for an interview that never reached a plan', () => {
    // The case the panel exists for. Without the distinction, an admin would read a partial
    // decision as the whole one, or the whole one as a partial.
    const { rerender } = render(<EarlySeatingCard early={view()} planned={false} />);
    expect(screen.getByText(/never reached one/)).toBeInTheDocument();

    rerender(<EarlySeatingCard early={view()} planned={true} />);
    expect(screen.queryByText(/never reached one/)).not.toBeInTheDocument();
    expect(screen.getByText(/The plan below absorbed them/)).toBeInTheDocument();
  });

  it('says on the summary when more was judged than the limits allowed', () => {
    // On the summary rather than the body: it changes how the count beside it reads, and the body
    // is collapsed by default.
    render(<EarlySeatingCard early={view({ overCap: true })} planned={false} />);
    expect(screen.getByText(/More was judged than the limits allowed/)).toBeInTheDocument();
  });

  it('lists the areas the caps never took, rather than reporting only what they took', () => {
    render(
      <EarlySeatingCard
        early={view({ deferred: [{ key: 'finance', label: 'Finance' }], overCap: true })}
        planned={true}
      />
    );
    expect(screen.getByText(/Judged worth covering, never taken/)).toBeInTheDocument();
    expect(screen.getByText(/Finance\./)).toBeInTheDocument();
  });

  it('says nothing was clear enough rather than rendering an empty list', () => {
    // Reachable: a pass that judged over the cap and seated nothing still records `overCap`.
    render(<EarlySeatingCard early={view({ seated: [], overCap: true })} planned={true} />);
    expect(screen.getByText(/Nothing was clear enough to act on early/)).toBeInTheDocument();
  });
});
