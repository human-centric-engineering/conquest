/**
 * Workflow diagram: Agentic Switcher.
 *
 * Documents the routing runtime that turns an opening questionnaire into a decision — conclude
 * here, or continue into a follow-up (`lib/app/questionnaire/experiences/routing/select.ts`).
 *
 * The diagram exists because the admin UI renders a journey as a flat ordered list on both the
 * Overview and Steps tabs, which cannot show what this actually is: a three-tier decision. Rules
 * are consulted first and win outright; the LLM selector runs only on what the rules did not
 * settle; the fallback catches everything else. Reading a list of steps gives no hint that ordering
 * carries that meaning.
 *
 * All four `ROUTING_SOURCES` appear as distinct paths — `rule`, `llm`, `fallback` and `budget`.
 * Budget deserves its own edge rather than a footnote: an exhausted run-level `costBudgetUsd`
 * concludes a run *before* the selector is ever consulted, and nothing in the current admin surface
 * says so.
 *
 * Deliberately domain-neutral: this is general-purpose conditional routing. Triage into a
 * specialist assessment, escalating depth on a topic, and branching by role are the same mechanism
 * pointed at different questionnaires — the copy here must not imply otherwise.
 */

import {
  EXPERIENCE_HANDOFF_AGENT_SLUG,
  EXPERIENCE_ROUTER_AGENT_SLUG,
} from '@/lib/app/questionnaire/experiences/constants';

import { applies, diagram, node } from '@/lib/app/questionnaire/workflows/types';

export const experienceSwitcherWorkflow = diagram({
  slug: 'experience-switcher',
  title: 'Agentic switcher',
  description:
    'An opening questionnaire, then a decision: conclude with a report, or continue into a follow-up chosen from the candidates.',
  sourceModule: 'lib/app/questionnaire/experiences/routing/select.ts',
  entryStepId: 'entry-leg',
  steps: [
    node({
      id: 'entry-leg',
      name: 'Entry leg',
      type: 'agent_call',
      x: 0,
      y: 120,
      description:
        'The respondent completes the entry questionnaire as an ordinary conversation. Nothing about this leg is experience-aware — it is the same live conversation pipeline any standalone questionnaire runs.',
      meta: {
        note: 'An ordinary questionnaire session. The experience only takes over once it completes.',
      },
      next: ['carry-over'],
    }),
    node({
      id: 'carry-over',
      name: 'Build carry-over',
      type: 'tool_call',
      x: 230,
      y: 120,
      description:
        "Freeze what the entry leg learned into a digest the decision reads: the filled data slots, and — unless the version is anonymous — the respondent's profile snapshot. Deterministic, and frozen at this moment so a later edit to the entry questionnaire cannot retroactively change a decision already made.",
      meta: {
        note: 'Deterministic. Frozen at handoff so a decision stays reproducible.',
        settings: [
          {
            key: 'carryProfile',
            label: 'Carry profile between legs',
            effect:
              "Carries the respondent's profile snapshot into later legs so they are not asked their name and role twice. The version's anonymous mode always wins.",
            scope: 'experience',
          },
        ],
      },
      next: ['budget-gate'],
    }),
    node({
      id: 'budget-gate',
      name: 'Run budget gate',
      type: 'guard',
      x: 460,
      y: 120,
      description:
        'Check spend so far against the run-level budget. This is a RUN-level cap, deliberately separate from the per-session cap on a questionnaire config — a per-session cap would silently allow double the intended spend across a two-leg journey.',
      meta: {
        note: 'Exhausted budget concludes the run before the selector is consulted — routing source `budget`.',
      },
      next: [
        { targetStepId: 'rules', condition: 'Pass' },
        { targetStepId: 'conclude', condition: 'Fail' },
      ],
    }),
    node({
      id: 'rules',
      name: 'Deterministic rules',
      type: 'route',
      x: 690,
      y: 120,
      description:
        'Author-written rules are evaluated in order and the FIRST match wins outright — the selector is never consulted for a case a rule already settled. Rules exist to hard-pin the handful of outcomes an author is certain about; everything less certain is what the selector is for.',
      config: {
        routes: [{ label: 'Rule matched' }, { label: 'No rule matched' }],
      },
      meta: {
        note: 'First match wins. A flat, ordered list — legible at a glance in a way a boolean tree is not.',
      },
      next: [
        { targetStepId: 'handoff', condition: 'Rule matched' },
        { targetStepId: 'selector', condition: 'No rule matched' },
      ],
    }),
    node({
      id: 'selector',
      name: 'Routing selector',
      type: 'agent_call',
      x: 690,
      y: 300,
      description:
        "Weighs the carry-over digest against each candidate's selection criteria and returns either `conclude` or a named step, with a confidence score. The respondent is waiting on this call, so it pairs a capable model with a short timeout and a deterministic fallback rather than reaching for the largest model available.",
      meta: {
        agentSlug: EXPERIENCE_ROUTER_AGENT_SLUG,
        note: 'The one LLM call in the decision. Bounded — the respondent is watching a spinner.',
        settings: [
          {
            key: 'showRoutingRationale',
            label: 'Show routing rationale',
            effect:
              'Shows the respondent why they were routed where they were, using the selector’s own message. Off delivers the handoff without explanation.',
            scope: 'experience',
          },
        ],
      },
      next: [
        { targetStepId: 'confidence', condition: 'Decision returned' },
        { targetStepId: 'fallback', condition: 'Errored or timed out' },
      ],
    }),
    node({
      id: 'confidence',
      name: 'Confidence threshold',
      type: 'guard',
      x: 920,
      y: 300,
      description:
        'Accept the selector only if it cleared the experience’s confidence threshold and named a step that actually exists. A confident answer routes; anything else drops to the fallback.',
      meta: {
        note: 'An unrecognised step name is treated exactly like low confidence — both mean "not trustworthy".',
      },
      next: [
        { targetStepId: 'handoff', condition: 'Pass' },
        { targetStepId: 'fallback', condition: 'Fail' },
      ],
    }),
    node({
      id: 'fallback',
      name: 'Fallback',
      type: 'route',
      x: 920,
      y: 470,
      description:
        'What to do when the selector cannot be trusted. `Conclude` is the default and the recommended choice — finishing with what was gathered is an honest outcome, whereas routing someone into a long follow-up on a coin-flip is not. A dead end always resolves to conclude; a respondent is never stranded.',
      config: {
        routes: [{ label: 'Conclude' }, { label: 'First candidate' }, { label: 'Default step' }],
      },
      meta: {
        note: 'Three configured behaviours. Never "blocked" — a run always has somewhere to go.',
      },
      next: [
        { targetStepId: 'conclude', condition: 'Conclude' },
        { targetStepId: 'handoff', condition: 'First candidate' },
        { targetStepId: 'handoff', condition: 'Default step' },
      ],
    }),
    node({
      id: 'handoff',
      name: 'Handoff briefing',
      type: 'agent_call',
      x: 1150,
      y: 120,
      description:
        'Compress the carry-over into a short briefing plus the bridging line that opens the next leg. Optional and non-blocking: when it fails, the next leg still receives the deterministic digest, so a journey never stalls on a briefing.',
      meta: {
        agentSlug: EXPERIENCE_HANDOFF_AGENT_SLUG,
        note: 'Optional. Failure degrades to the deterministic digest rather than blocking the handoff.',
        settings: [
          {
            key: 'summariseCarryOver',
            label: 'Summarise carry-over',
            effect:
              'Runs this compression pass. Off hands the next leg the deterministic data-slot digest alone — cheaper and fully predictable, but flatter.',
            scope: 'experience',
          },
        ],
      },
      next: ['follow-up-leg'],
    }),
    node({
      id: 'follow-up-leg',
      name: 'Follow-up leg',
      type: 'agent_call',
      x: 1380,
      y: 120,
      description:
        'A second session on the chosen questionnaire, opening from the briefing. Sensitivity level and notes carry across from the entry leg so a safeguarding disclosure the respondent already made is never re-opened.',
      meta: {
        note: 'A new session. Sensitivity carries across — re-asking a disclosure would be a real harm, not a rough edge.',
      },
      next: ['conclude'],
    }),
    node({
      id: 'conclude',
      name: 'Conclude the run',
      type: 'report',
      x: 1610,
      y: 300,
      description:
        'The single choke point where a journey is known to be over — reached from a budget stop, a fallback, or the end of a follow-up leg. Enqueues the run report, which covers every leg the respondent met. Individual legs generate no report of their own.',
      meta: {
        note: 'One report per RUN, not per leg. The entry leg’s settings govern it; the last leg varies by routing.',
      },
    }),
  ],
  applicability: () =>
    applies(
      'Experiences compose whole questionnaires, so this pipeline is not scoped to any single version.'
    ),
});
