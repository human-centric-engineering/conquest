/**
 * Worked examples of each Experience kind — pure, client-safe presentation data.
 *
 * The admin UI explains Experiences at the field level (there are dozens of `<FieldHelp>` popovers)
 * and in a single conceptual blurb on the list page, but nothing in between showed what a finished
 * experience actually looks like. These are that middle layer: concrete enough to copy, short
 * enough to read.
 *
 * **The switcher examples are deliberately drawn from three unrelated domains.** `agentic_switcher`
 * is general-purpose conditional routing, and lead qualification is one application among many —
 * triage, escalating depth, and role-branching are the same mechanism pointed at different
 * questionnaires. Illustrating it with a single commercial scenario would narrow what authors
 * imagine the feature can do and leak a sales framing that many customers do not share. Keep any
 * example added here domain-neutral as a set: describe the mechanism, not one customer's use of it.
 *
 * Kept free of server / prisma / React imports so client components can render these directly.
 */

import type { ExperienceKind } from '@/lib/app/questionnaire/experiences/types';

/** One step in a worked example, as the reader walks it. */
export interface ExampleStep {
  /** Matches the vocabulary of `EXPERIENCE_STEP_KIND_LABELS` so the example maps onto the editor. */
  kind: string;
  title: string;
  /** What this step contributes to the journey. */
  detail: string;
}

/** A complete worked example of one experience kind. */
export interface ExperienceExample {
  id: string;
  title: string;
  /** The situation this experience is built for, in one or two sentences. */
  scenario: string;
  steps: readonly ExampleStep[];
  /** What decides where a respondent goes — the sentence an author would put in Routing. */
  routing: string;
  /** What the respondent's side of it feels like. */
  respondentSees: string;
  /** What the admin ends up with. */
  adminGets: string;
}

const SWITCHER_EXAMPLES: readonly ExperienceExample[] = [
  {
    id: 'triage',
    title: 'Triage into a specialist assessment',
    scenario:
      'A short intake questionnaire that everyone completes, followed by whichever in-depth assessment actually fits what they described.',
    steps: [
      {
        kind: 'Entry',
        title: 'Initial intake',
        detail:
          'Eight questions covering the presenting situation, its history, and how urgent it feels.',
      },
      {
        kind: 'Branch candidate',
        title: 'Financial assessment',
        detail: 'Chosen when the intake points at money, debt, or benefits as the primary concern.',
      },
      {
        kind: 'Branch candidate',
        title: 'Housing assessment',
        detail: 'Chosen when the intake points at tenancy, repairs, or risk of homelessness.',
      },
      {
        kind: 'Branch candidate',
        title: 'Wellbeing assessment',
        detail: 'Chosen when the intake points at health, isolation, or caring responsibilities.',
      },
    ],
    routing:
      'One rule pins the urgent cases straight to wellbeing. Everything else goes to the selector, which reads the intake against each assessment’s selection criteria.',
    respondentSees:
      'One conversation that gets more specific after the first few minutes. With stitched continuity they never see a join at all.',
    adminGets:
      'A single report covering the intake and the assessment, plus a per-step cohort report showing how the intake population divided.',
  },
  {
    id: 'depth',
    title: 'Escalating depth on a topic',
    scenario:
      'A broad survey that stays short for most people, but opens into a deep-dive for the minority who have a lot to say on one theme.',
    steps: [
      {
        kind: 'Entry',
        title: 'Broad survey',
        detail: 'Covers six themes at one or two questions each. Ten minutes at most.',
      },
      {
        kind: 'Branch candidate',
        title: 'Deep-dive: ways of working',
        detail: 'Chosen when the respondent gave detailed or strongly-felt answers on that theme.',
      },
      {
        kind: 'Branch candidate',
        title: 'Deep-dive: tools and systems',
        detail: 'Chosen on the same basis for the tooling theme.',
      },
    ],
    routing:
      'No rules at all — the selector decides, and its fallback is set to conclude. Someone with nothing more to say is finished in ten minutes, which is the point.',
    respondentSees:
      'A survey that takes them seriously. Where they showed interest, it asks more; where they did not, it ends.',
    adminGets:
      'Breadth across everyone and depth from the people who had it to give, without imposing a forty-minute survey on the whole population.',
  },
  {
    id: 'role',
    title: 'Branch by role',
    scenario:
      'One organisation-wide questionnaire whose follow-up differs by the respondent’s position, without maintaining separate invitation lists.',
    steps: [
      {
        kind: 'Entry',
        title: 'Shared opening',
        detail: 'Questions everyone answers, including what the respondent’s role involves.',
      },
      {
        kind: 'Branch candidate',
        title: 'Manager follow-up',
        detail: 'Team decisions, resourcing, and what they can and cannot influence.',
      },
      {
        kind: 'Branch candidate',
        title: 'Practitioner follow-up',
        detail: 'Day-to-day work, obstacles, and what would actually help.',
      },
    ],
    routing:
      'Two deterministic rules on the captured role slot — this is a case an author is certain about, so it does not need a model. The selector only handles the answers the rules did not anticipate.',
    respondentSees:
      'One link to share with everyone, and a questionnaire that turns out to be about their actual job.',
    adminGets:
      'Comparable answers on the shared opening across the whole organisation, plus role-specific depth, from a single experience.',
  },
];

const MEETING_EXAMPLES: readonly ExperienceExample[] = [
  {
    id: 'temperature-check',
    title: 'Workshop temperature-check',
    scenario:
      'Forty people in a room. The facilitator wants what everyone actually thinks, not what the three most confident people say out loud.',
    steps: [
      {
        kind: 'Entry',
        title: 'Join the meeting',
        detail: 'Participants arrive on the join link. No login needed if access is set to public.',
      },
      {
        kind: 'Breakout',
        title: 'Where are we now?',
        detail:
          'Six questions, ten minutes on the clock. Everyone answers individually and at once.',
      },
    ],
    routing:
      'None — a facilitated meeting has no fork. The sequence is the design, and the facilitator controls the pace.',
    respondentSees:
      'A short private conversation on their own phone or laptop, then the synthesis on the shared screen if it has been surfaced to them.',
    adminGets:
      'Findings clustered across all forty people — agreements, tensions, outliers — with anything supported by too few people withheld, and a count of what was held back.',
  },
  {
    id: 'rooms',
    title: 'Rooms with different questions',
    scenario:
      'One session split into four groups, each looking at a different part of the same problem, with one person per group writing up the discussion.',
    steps: [
      {
        kind: 'Entry',
        title: 'Join the meeting',
        detail: 'Participants arrive and pick a room while the breakout is open.',
      },
      {
        kind: 'Breakout',
        title: 'Four parallel rooms',
        detail:
          'Each room has its own questionnaire and runs in scribe mode: one person holds the pen and writes the room’s answers into a single session. The pen is first-come.',
      },
    ],
    routing:
      'None. Rooms are a refinement within the breakout period, not a routing decision — a room is chosen by the participant, not by a model.',
    respondentSees:
      'A group discussion with one person typing, rather than everyone answering separately on their own device.',
    adminGets:
      'Each room synthesised on its own, since the rooms were answering different questions. The facilitator walks the whole meeting through all four in turn.',
  },
];

/** Worked examples per experience kind, in the order they should be read. */
export const EXPERIENCE_EXAMPLES: Record<ExperienceKind, readonly ExperienceExample[]> = {
  agentic_switcher: SWITCHER_EXAMPLES,
  facilitated_meeting: MEETING_EXAMPLES,
};

/** The examples for one kind. */
export function examplesForKind(kind: ExperienceKind): readonly ExperienceExample[] {
  return EXPERIENCE_EXAMPLES[kind] ?? [];
}
