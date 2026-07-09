/**
 * Workflow diagram: Preview Turn Inspector.
 *
 * The admin-only observability layer that captures, for each respondent turn in a *preview*
 * session, every agent/LLM and embedding/vector call the turn made — model, latency, cost,
 * tokens, and the raw prompt + response — then streams the assembled trace to the inspector
 * drawer (`lib/app/questionnaire/inspector`). Purely deterministic plumbing wrapped around the
 * agentic turn: it runs no model of its own, so every node here is deterministic *except* the
 * vector-call capture, which surfaces where the turn used an embedding engine. Doubly gated:
 * the session must be a preview AND `previewInspectorEnabled` must be on, so it is NEVER emitted
 * to a real respondent. Ends by handing a turn off to the Turn Evaluator on request.
 */

import {
  applies,
  diagram,
  inactive,
  node,
  unavailable,
} from '@/lib/app/questionnaire/workflows/types';

export const turnInspectorWorkflow = diagram({
  slug: 'turn-inspector',
  title: 'Preview turn inspector',
  description:
    "A glass-box view of a live turn, for admins previewing a questionnaire. As the turn runs, the inspector records every agent and embedding call — the model, the cost, the latency, and the exact prompt and response — assembles them into a per-turn trace, and streams it to a drawer. It's pure observability: it changes nothing about the turn, and it never runs for a real respondent.",
  sourceModule: 'lib/app/questionnaire/inspector/index.ts',
  entryStepId: 'gate',
  errorStrategy: 'fail',
  steps: [
    node({
      id: 'gate',
      name: 'Preview + config gate',
      type: 'guard',
      x: 0,
      y: 0,
      description:
        'The inspector only arms for an admin preview session with the inspector toggle on — a real respondent session never carries trace data (a privacy boundary, not just a setting). Pass → capture.',
      meta: {
        note: 'Doubly gated: session.isPreview AND previewInspectorEnabled. Off for real respondents.',
        settings: [
          {
            key: 'previewInspectorEnabled',
            label: 'Preview turn inspector',
            effect:
              'Turns the per-turn inspector trace on for admin preview sessions of this version.',
          },
        ],
      },
      next: [{ targetStepId: 'capture', condition: 'Pass' }],
    }),
    node({
      id: 'capture',
      name: 'Record agent calls',
      type: 'tool_call',
      x: 220,
      y: 0,
      description:
        'As the turn runs, each app-seam LLM call (extraction, gates, contradiction, selection, phrasing) pushes a trace — model, provider, latency, estimated cost, token counts, and the raw prompt + response — into the turn sink.',
      meta: { note: 'Each LLM call site records an AgentCallTrace via the RecordAgentCall sink.' },
      next: ['embed'],
    }),
    node({
      id: 'embed',
      name: 'Record vector calls',
      type: 'rag_retrieve',
      x: 440,
      y: 0,
      description:
        'Embedding calls the turn made — candidate ranking for extraction, adaptive next-slot/question ranking — are captured distinctly: input tokens and a vector width, but no completion and no free-text response, so the drawer renders them as a "VEC" call whose output is the ranking, not text.',
      meta: {
        vector: {
          status: 'active',
          description:
            'The pgvector similarity calls a turn makes (extraction candidate ranking, adaptive slot/question ranking) are recorded via buildEmbeddingTrace and tagged kind:"embedding" — this is where the turn touched the embedding engine.',
        },
        note: 'Embedding/vector calls captured as kind:"embedding" (VEC) traces — no completion tokens.',
      },
      next: ['aggregate'],
    }),
    node({
      id: 'aggregate',
      name: 'Assemble turn',
      type: 'tool_call',
      x: 660,
      y: 0,
      description:
        'Collect the turn’s calls in execution order into one TurnInspectorData and roll up the totals — total cost, total latency, and tokens in/out — that head the drawer.',
      meta: { note: 'TurnInspectorData { turnIndex, calls[] } + cost/latency/token totals.' },
      next: ['stream'],
    }),
    node({
      id: 'stream',
      name: 'Stream to drawer',
      type: 'tool_call',
      x: 880,
      y: 0,
      description:
        'Emit the assembled trace as a stream event so the admin inspector drawer can render the per-call breakdown alongside the respondent’s conversation — inspector data is never persisted, so this is the only place it lives.',
      meta: { note: 'Emit the inspector stream event to the admin drawer (never persisted).' },
      next: ['serialize'],
    }),
    node({
      id: 'serialize',
      name: 'Serialize turn (on demand)',
      type: 'tool_call',
      x: 1100,
      y: 0,
      description:
        'On demand, formatInspectorTurn renders the turn to the exact Markdown the admin copies to the clipboard — and the same text the Turn Evaluator reads, so the model judges precisely what the admin sees.',
      meta: { note: 'formatInspectorTurn → the copy-to-clipboard text and the evaluator input.' },
      next: ['handoff'],
    }),
    node({
      id: 'handoff',
      name: 'Evaluate turn (optional)',
      type: 'report',
      x: 1320,
      y: 0,
      description:
        'From the drawer the admin can hand the serialized turn to the Turn Evaluator, which scores its interviewing/extraction/selection quality. See the "Turn evaluation" workflow.',
      meta: { note: 'Optional hand-off to the Turn Evaluator (the turn-evaluation workflow).' },
    }),
  ],
  applicability: (ctx) => {
    if (!ctx.flags.liveSessions) {
      return unavailable('Live sessions are not enabled.');
    }
    if (!ctx.config.previewInspectorEnabled) {
      return inactive('The preview turn inspector is turned off for this version.');
    }
    return applies('Admin preview sessions on this version capture a per-turn inspector trace.');
  },
});
