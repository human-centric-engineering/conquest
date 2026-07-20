/**
 * Workflow diagram: Experience run lifecycle.
 *
 * Documents the respondent's journey through a multi-leg experience — how they are addressed, how
 * they are authorised, what they see at the seam between two questionnaires, and where the single
 * report comes from.
 *
 * This is the diagram that explains CONTINUITY, and continuity is the part of Experiences most
 * likely to be misread. `linked` and `stitched` have an identical persistence shape: one session
 * per leg either way, zero differing write paths, zero differing report scoping. `stitched` is a
 * PRESENTATION flag. Drawing both as one path with a branch only at the seam is not a
 * simplification for the reader's benefit — it is what the system actually does, and an author who
 * believes otherwise will design against a model that does not exist.
 *
 * The credential deserves its own node for a specific reason: experience transcripts hold raw
 * safeguarding disclosures and the stitched-transcript endpoint replays them, so the run credential
 * is an httpOnly cookie and never a URL token. A `?t=` credential would land in browser history,
 * `Referer` headers and pasted links. `publicRef` addresses a run; it never authorises one.
 */

import { applies, diagram, node } from '@/lib/app/questionnaire/workflows/types';

export const experienceRunLifecycleWorkflow = diagram({
  slug: 'experience-run-lifecycle',
  title: 'Run lifecycle & continuity',
  description:
    'What a respondent actually meets: one stable address, a run that survives a refresh, and a single report at the end.',
  sourceModule: 'lib/app/questionnaire/experiences/run/types.ts',
  entryStepId: 'address',
  steps: [
    node({
      id: 'address',
      name: 'Stable address',
      type: 'tool_call',
      x: 0,
      y: 160,
      description:
        'Every leg of the journey lives at one URL — the experience’s public reference. Because the address never changes, advancing to the next leg cannot navigate anywhere: the destination is already the current page, so continuing refreshes it in place.',
      meta: {
        note: 'The URL is already correct for leg B. Pushing a route here is a silent no-op.',
      },
      next: ['credential'],
    }),
    node({
      id: 'credential',
      name: 'Run credential',
      type: 'guard',
      x: 230,
      y: 160,
      description:
        'A run-scoped httpOnly cookie, signed and domain-separated from the ordinary session token. Deliberately not a URL token: this journey’s transcripts can contain raw safeguarding disclosures, and a credential in the query string would leak into history, referrer headers and pasted links. Cookie names are treated as untrusted — the payload is verified, not the label on it.',
      meta: {
        note: 'httpOnly, run-scoped, never in the URL. `publicRef` addresses; it does not authorise.',
      },
      next: [
        { targetStepId: 'leg-a', condition: 'Pass' },
        { targetStepId: 'new-run', condition: 'Fail' },
      ],
    }),
    node({
      id: 'new-run',
      name: 'Start a run',
      type: 'tool_call',
      x: 230,
      y: 340,
      description:
        'No valid credential means this is a first arrival: create the run and issue the cookie. A respondent returning on a DIFFERENT device has no cookie either, and cross-device resume is a known and deliberate gap rather than a bug.',
      meta: { note: 'Cross-device resume is not built. A new device starts a new run.' },
      next: ['leg-a'],
    }),
    node({
      id: 'leg-a',
      name: 'Leg A',
      type: 'agent_call',
      x: 460,
      y: 160,
      description:
        'The first questionnaire session. Run membership is read from the run-status view rather than from the submit response, so a refresh mid-journey does not strand the respondent outside their own run.',
      meta: {
        note: 'Membership rides the status view, not the submit response — that is what survives a refresh.',
      },
      next: ['seam'],
    }),
    node({
      id: 'seam',
      name: 'The seam',
      type: 'route',
      x: 690,
      y: 160,
      description:
        'The one place the continuity mode is visible. Both modes persist identically — one session per leg, the same rows, the same report scoping — and differ only in what the respondent is shown. That is what lets an experience switch between them mid-flight without migrating anything.',
      config: {
        routes: [{ label: 'Linked' }, { label: 'Stitched' }],
      },
      meta: {
        note: 'Presentation only. If a change seems to need `stitched` to persist differently, the requirement is wrong.',
        settings: [
          {
            key: 'stitchedSeamMarker',
            label: 'Seam marker',
            effect:
              'Under stitched, how visible the join between legs is — a subtle divider carrying the step title, or nothing at all.',
            scope: 'experience',
          },
        ],
      },
      next: [
        { targetStepId: 'handoff-card', condition: 'Linked' },
        { targetStepId: 'continuation', condition: 'Stitched' },
      ],
    }),
    node({
      id: 'handoff-card',
      name: 'Handoff card',
      type: 'human_approval',
      x: 920,
      y: 60,
      description:
        'Linked mode shows an explicit handoff: two visibly separate chats with a card between them that the respondent acknowledges before continuing.',
      meta: { note: 'Two chats, one explicit step between them.' },
      next: ['leg-b'],
    }),
    node({
      id: 'continuation',
      name: 'Stitched continuation',
      type: 'tool_call',
      x: 920,
      y: 260,
      description:
        'Stitched mode reads back the earlier leg’s history into one continuous chat. The history is a READ of rows that already exist — no session is rewritten and nothing is merged.',
      meta: { note: 'One continuous chat over two sessions. A read, not a rewrite.' },
      next: ['leg-b'],
    }),
    node({
      id: 'leg-b',
      name: 'Leg B',
      type: 'agent_call',
      x: 1150,
      y: 160,
      description:
        'The follow-up session. Sensitivity level and notes carried across at the handoff, so a disclosure already made is not re-opened. The run-level budget continues to apply across both legs.',
      meta: {
        note: 'Sensitivity carries across legs — a blocker when P15 was designed, not a polish item.',
        settings: [
          {
            key: 'carryProfile',
            label: 'Carry profile between legs',
            effect:
              'Carries the profile snapshot forward so the respondent is not asked their name and role a second time.',
            scope: 'experience',
          },
        ],
      },
      next: ['conclude'],
    }),
    node({
      id: 'conclude',
      name: 'Conclude the run',
      type: 'tool_call',
      x: 1380,
      y: 160,
      description:
        'The one choke point where a journey is known to be over, and therefore the only sound place to enqueue a report.',
      meta: { note: 'Every terminal path funnels through here.' },
      next: ['run-report'],
    }),
    node({
      id: 'run-report',
      name: 'Run report',
      type: 'report',
      x: 1610,
      y: 160,
      description:
        'ONE report covering every leg. Its settings come from the ENTRY leg’s version — the last leg varies by routing, so keying settings to it would make an experience’s reports inconsistent for reasons an author never chose. Knowledge-base scope comes from the experience, and coverage is summed across legs.',
      meta: {
        note: 'A leg produces no report of its own. Settings from the entry leg; coverage summed.',
      },
    }),
  ],
  applicability: () =>
    applies(
      'Experiences compose whole questionnaires, so this pipeline is not scoped to any single version.'
    ),
});
