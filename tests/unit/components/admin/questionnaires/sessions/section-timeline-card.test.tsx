// @vitest-environment happy-dom

/**
 * SectionTimelineCard — the admin's read-back of a sectioned run (P21 phase D).
 *
 * Anti-green-bar: this asserts the distinctions the panel exists to draw, not that text renders.
 * Each one below is a claim about the run that would be wrong if the panel collapsed it:
 *
 *  - a section RELEASED BY THE TURN LIMIT closed without its gate being satisfied, and reads
 *    differently from one the respondent chose to leave;
 *  - `openedAtTurn: 0` means never opened, not "opened at turn zero";
 *  - a section the version no longer carries is shown, because turns were tagged with it;
 *  - unknown spend is absent, never rendered as $0.00.
 *
 * @see components/admin/questionnaires/sessions/section-timeline-card.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SectionTimelineCard } from '@/components/admin/questionnaires/sessions/section-timeline-card';
import type { AdminSectionTimelineEntry } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-view';

function entry(
  over: Partial<AdminSectionTimelineEntry> & { key: string }
): AdminSectionTimelineEntry {
  return {
    label: over.key,
    position: 1,
    status: 'closed',
    openedAtTurn: 1,
    closedAtTurn: 4,
    closeReason: 'respondent',
    reopenCount: 0,
    turnsSpent: 3,
    costUsd: null,
    stale: false,
    ...over,
  };
}

describe('SectionTimelineCard', () => {
  it('summarises how many parts were finished', () => {
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: 'b',
          entries: [
            entry({ key: 'a', label: 'Context', position: 1 }),
            entry({
              key: 'b',
              label: 'Problem',
              position: 2,
              status: 'in_progress',
              closedAtTurn: null,
              closeReason: null,
            }),
          ],
        }}
      />
    );
    expect(screen.getByText('1 of 2 finished')).toBeTruthy();
  });

  it('marks where the run stopped', () => {
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: 'b',
          entries: [
            entry({ key: 'a', label: 'Context' }),
            entry({
              key: 'b',
              label: 'Problem',
              position: 2,
              status: 'in_progress',
              closedAtTurn: null,
              closeReason: null,
            }),
          ],
        }}
      />
    );
    expect(screen.getByText('Where it stopped')).toBeTruthy();
  });

  it('names the turn limit as the reason a capped section closed', () => {
    // The one close reason that says the section closed WITHOUT its gate being satisfied. Drawn as
    // a tick alongside the others, an operator would never look at what was left unanswered there.
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: null,
          entries: [entry({ key: 'a', label: 'Context', closeReason: 'cap' })],
        }}
      />
    );
    expect(screen.getByText('Released by the turn limit')).toBeTruthy();
  });

  it('says a section was never opened rather than showing turn zero', () => {
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: null,
          entries: [
            entry({
              key: 'a',
              label: 'Appetite',
              status: 'not_started',
              openedAtTurn: 0,
              closedAtTurn: null,
              closeReason: null,
              turnsSpent: 0,
            }),
          ],
        }}
      />
    );
    expect(screen.getByText('never opened')).toBeTruthy();
    expect(screen.queryByText(/opened at turn 0/)).toBeNull();
    expect(screen.getByText('Not reached')).toBeTruthy();
  });

  it('does not call a worked section "never opened" just because its stamp is zero', () => {
    // The regression this pins. `openedAtTurn` is stamped with `selectionRound` — the count of turns
    // BEFORE the one being written — so the section every respondent starts in is stamped 0 while
    // its first exchange is turn 1. A card testing `openedAtTurn > 0` told the operator that a
    // finished section with six turns and recorded spend was never opened.
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: null,
          entries: [
            entry({
              key: 'ctx',
              label: 'Context',
              status: 'closed',
              openedAtTurn: 0,
              closedAtTurn: 6,
              turnsSpent: 6,
              costUsd: 0.12,
            }),
          ],
        }}
      />
    );
    expect(screen.queryByText('never opened')).toBeNull();
    // Described in words rather than printed, because the one number it must not claim is "turn 0".
    expect(screen.getByText('opened at the first turn')).toBeTruthy();
    expect(screen.queryByText(/opened at turn 0/)).toBeNull();
  });

  it('never marks a part that was never reached as where the run stopped', () => {
    // `buildSectionState` synthesises an active key when the stored run carries none, so a session
    // that banked a run without taking a turn resolves its FIRST section as active. Badging it would
    // put "Not reached" and "Where it stopped" on the same row, which reads as a contradiction.
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: 'ctx',
          entries: [
            entry({
              key: 'ctx',
              label: 'Context',
              status: 'not_started',
              openedAtTurn: 0,
              closedAtTurn: null,
              closeReason: null,
              turnsSpent: 0,
            }),
          ],
        }}
      />
    );
    expect(screen.getByText('Not reached')).toBeTruthy();
    expect(screen.queryByText('Where it stopped')).toBeNull();
  });

  it('reports a revisit in words rather than as a count nobody can read', () => {
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: null,
          entries: [entry({ key: 'a', label: 'Context', reopenCount: 1 })],
        }}
      />
    );
    expect(screen.getByText('came back once')).toBeTruthy();
  });

  it('shows a section the version no longer carries, and says so', () => {
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: null,
          entries: [entry({ key: 'gone-topic', label: 'gone-topic', stale: true })],
        }}
      />
    );
    expect(screen.getByText('gone-topic')).toBeTruthy();
    expect(screen.getByText('no longer in this questionnaire')).toBeTruthy();
  });

  it('omits spend entirely when no turn there recorded a cost', () => {
    // Rendering "$0.00" would claim the section was free, which is a different thing from unknown.
    const { container } = render(
      <SectionTimelineCard
        timeline={{
          activeKey: null,
          entries: [entry({ key: 'a', label: 'Context', costUsd: null })],
        }}
      />
    );
    expect(container.textContent).not.toContain('$');
  });

  it('shows small spend at enough precision to be worth reading', () => {
    render(
      <SectionTimelineCard
        timeline={{
          activeKey: null,
          entries: [entry({ key: 'a', label: 'Context', costUsd: 0.0031 })],
        }}
      />
    );
    expect(screen.getByText('$0.0031')).toBeTruthy();
  });
});
