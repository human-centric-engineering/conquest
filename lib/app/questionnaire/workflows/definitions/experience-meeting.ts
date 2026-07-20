/**
 * Workflow diagram: Facilitated Meeting.
 *
 * Documents the live breakout runtime (`lib/app/questionnaire/experiences/meeting/`): many people
 * answer the same short questionnaire at once, and their answers are synthesised into findings a
 * facilitator reads aloud to the room.
 *
 * Two things about this pipeline are invisible in the admin UI and are the reason the diagram is
 * worth having.
 *
 * First, a breakout is a PERIOD OF TIME, not a place, and it has three phases — `running`, then
 * `grace`, then `closed`. During grace a participant may submit what they already have but may not
 * start anything new. One boolean cannot express that, which is exactly why it is drawn as two
 * gates rather than one.
 *
 * Second, the facilitator drives and the clock only advises. A timer NEVER ends a breakout. That is
 * a deliberate product decision — a room mid-sentence should not be cut off by a countdown — and a
 * diagram that drew the clock as a terminator would misrepresent it.
 *
 * The k-anonymity gate is drawn on the critical path because it is structural here, not
 * configurable politeness: the synthesis is read ALOUD to the room it came from, so audience and
 * subjects are the same people.
 */

import { MEETING_SYNTHESIS_AGENT_SLUG } from '@/lib/app/questionnaire/experiences/constants';

import { applies, diagram, node } from '@/lib/app/questionnaire/workflows/types';

export const experienceMeetingWorkflow = diagram({
  slug: 'experience-meeting',
  title: 'Facilitated meeting',
  description:
    'The same short questionnaire run by many people at once, synthesised per breakout for a live facilitator.',
  sourceModule: 'lib/app/questionnaire/experiences/meeting/synthesise.ts',
  entryStepId: 'meeting-opens',
  steps: [
    node({
      id: 'meeting-opens',
      name: 'Meeting opens',
      type: 'tool_call',
      x: 0,
      y: 160,
      description:
        'The facilitator creates an occurrence of the experience and shares its join link. A meeting sits ABOVE runs rather than inside one: a run is one person’s journey, while a meeting is the shared live occurrence many runs belong to.',
      meta: {
        note: 'A meeting is not a run. One meeting, many runs.',
      },
      next: ['participants-join'],
    }),
    node({
      id: 'participants-join',
      name: 'Participants join',
      type: 'tool_call',
      x: 230,
      y: 160,
      description:
        'People arrive on the join link. They may span cohorts or belong to none at all — a public one-off workshop is a supported case — and whether a login is required is governed by the experience’s access mode.',
      meta: {
        note: 'Participants may span cohorts, or none. Login is optional per access mode.',
      },
      next: ['breakout-opens'],
    }),
    node({
      id: 'breakout-opens',
      name: 'Facilitator opens a breakout',
      type: 'human_approval',
      x: 460,
      y: 160,
      description:
        'The facilitator starts the period by hand. The end time is STORED at this moment rather than derived from the step’s duration — editing the authored duration mid-meeting must not move a clock a room is already watching. Only one breakout runs at a time; a second concurrent period would split answers across two of them.',
      meta: {
        note: 'Duration is authored on the step; the CLOCK is stored on the meeting. Never two at once.',
      },
      next: ['room-pick'],
    }),
    node({
      id: 'room-pick',
      name: 'Rooms',
      type: 'parallel',
      x: 690,
      y: 160,
      description:
        'A breakout may be split into rooms, each with its own questionnaire. Rooms are worked in one of two modes: `individual`, where everyone answers for themselves, or `scribe`, where one person holds the pen and writes the room’s answers into a single session. The pen is first-come.',
      config: {
        branches: [{ label: 'Room' }, { label: 'Room' }],
      },
      meta: {
        note: 'Scribe mode is ONE session per room. A room cannot be chosen once grace has begun.',
      },
      next: ['running'],
    }),
    node({
      id: 'running',
      name: 'Phase: running',
      type: 'tool_call',
      x: 920,
      y: 160,
      description:
        'The open period. Participants may both answer new questions and submit. The clock is advisory throughout — when it runs out the breakout does not end, it moves to grace, and an overrunning meeting is merely displayed as such.',
      meta: {
        note: 'The clock advises; the facilitator decides. `isOverrunning` is display-only.',
      },
      next: ['grace'],
    }),
    node({
      id: 'grace',
      name: 'Phase: grace',
      type: 'guard',
      x: 1150,
      y: 160,
      description:
        'The wind-down. Submitting is still allowed but starting something new is not — two separate permissions, which is why one flag could not carry this phase. Boundaries favour the participant, and a clock that cannot be parsed FAILS OPEN rather than locking someone out of work they have already done.',
      meta: {
        note: 'Submit yes, answer no. An unparseable clock fails OPEN — toward the participant.',
        settings: [
          {
            key: 'breakoutGraceSeconds',
            label: 'Grace window',
            effect:
              'How long after the clock expires participants may still submit answers they had already begun.',
            scope: 'experience',
          },
        ],
      },
      next: ['closed'],
    }),
    node({
      id: 'closed',
      name: 'Phase: closed',
      type: 'tool_call',
      x: 1380,
      y: 160,
      description:
        'The facilitator ends the breakout. Nothing further is accepted for this period, and the material collected is handed to the synthesiser.',
      meta: { note: 'Ended by the facilitator, never by the timer.' },
      next: ['material'],
    }),
    node({
      id: 'material',
      name: 'Assemble material',
      type: 'tool_call',
      x: 1610,
      y: 160,
      description:
        'Gather what the synthesiser is allowed to read: the filled data slots, the rationales behind them, the refinement history that shows where people MOVED during the conversation, and the questionnaire’s own background. Raw chat is never included, and participants appear only as indices — P1, P2 — so no session identifier can reach the model.',
      meta: {
        note: 'Never raw chat. Participants are P1/P2 indices; a test asserts no session id appears.',
      },
      next: ['synthesise'],
    }),
    node({
      id: 'synthesise',
      name: 'Synthesise findings',
      type: 'agent_call',
      x: 1840,
      y: 160,
      description:
        'Cluster positions across participants, weigh agreement against dissent, and count support honestly. Nobody is watching a spinner here — the facilitator is still talking to the room — so this gets a longer timeout and a larger budget than the routing selector, and correctness matters more than latency. Rooms are synthesised SEPARATELY, since they may be running different questionnaires.',
      meta: {
        agentSlug: MEETING_SYNTHESIS_AGENT_SLUG,
        note: 'Reasoning-tier and unhurried — nobody is waiting. One synthesis per room.',
        settings: [
          {
            key: 'synthesisEveryNCompletions',
            label: 'Re-synthesise after N completions',
            effect:
              'How often the breakout is re-synthesised as more people finish. Lower is more live and more expensive.',
            scope: 'experience',
          },
          {
            key: 'synthesisInstructions',
            label: 'Synthesis instructions',
            effect:
              'Extra steer on what the synthesiser should look for. It cannot loosen the support gate below.',
            scope: 'experience',
          },
        ],
      },
      next: ['anonymity'],
    }),
    node({
      id: 'anonymity',
      name: 'k-anonymity gate',
      type: 'guard',
      x: 2070,
      y: 160,
      description:
        'Withhold any finding supported by too few people. Stricter in spirit than the same gate elsewhere in ConQuest, because the output is read aloud to the very room it came from — audience and subjects are the same people. A floor of two is enforced in code whatever the setting says, and surfacing insights to respondents can never override it. Suppression reports a COUNT to the facilitator, never the withheld statements themselves.',
      meta: {
        note: 'The model is not in the trust path. Floor of 2 enforced in code; the gate is the gate.',
        settings: [
          {
            key: 'insightMinSupport',
            label: 'Minimum support',
            effect:
              'How many respondents must support a finding before it may be shown. The code floor of two applies regardless.',
            scope: 'experience',
          },
          {
            key: 'surfaceInsightsToRespondents',
            label: 'Surface insights to respondents',
            effect:
              'Whether participants see the synthesis too, not just the facilitator. Cannot override the support gate.',
            scope: 'experience',
          },
        ],
      },
      next: [
        { targetStepId: 'console', condition: 'Pass' },
        { targetStepId: 'withheld', condition: 'Fail' },
      ],
    }),
    node({
      id: 'withheld',
      name: 'Withheld',
      type: 'tool_call',
      x: 2300,
      y: 330,
      description:
        'A finding with too little support is dropped. The facilitator is told HOW MANY findings were withheld, never what they said — reporting the statements would defeat the gate entirely, since a facilitator who reads them aloud has published them anyway. Support is also clamped to the room size, which is an honesty guard on the count rather than a second gate: it can never suppress on its own.',
      meta: {
        note: 'A count, never the statements. Clamping is honesty about the number, not a second gate.',
      },
    }),
    node({
      id: 'console',
      name: 'Facilitator walks the room',
      type: 'report',
      x: 2300,
      y: 160,
      description:
        'Findings land in the live console and the facilitator walks the room through them, marking each as covered. Regenerating a synthesis REPLACES the findings and loses those marks — intended, since a stale mark on a changed finding would be worse than none.',
      meta: {
        note: 'Regenerating replaces insights and clears `covered` marks — deliberate.',
        settings: [
          {
            key: 'consoleDisplayMode',
            label: 'Console display mode',
            effect:
              'Presentation mode enlarges type and strips controls for a projector or a shared video call, where the console may be the only surface anyone can see.',
            scope: 'experience',
          },
          {
            key: 'respondentInsightDisplay',
            label: 'Respondent insight display',
            effect:
              'Where participants see the synthesis on their own device, when surfacing is enabled at all.',
            scope: 'experience',
          },
        ],
      },
    }),
  ],
  applicability: () =>
    applies(
      'Experiences compose whole questionnaires, so this pipeline is not scoped to any single version.'
    ),
});
