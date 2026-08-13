/**
 * Author the Merlin5 Growth Assessor™ from its source workbook — deterministically.
 *
 * ```
 * npm run author:merlin5 -- ~/Downloads/Merlin5_Growth_Assessor_Question_Set_v3.xlsx [--replace]
 * ```
 *
 * ## Why a script and not a seed
 *
 * This is a **client's instrument**, not platform data. Seeding it would create it on every
 * `db:seed` of every install and commit 70 rows of someone else's intellectual property to this
 * repo. Reading the workbook from a path at run time keeps the content out of git entirely — the
 * script encodes only the *mapping*, which is ours.
 *
 * ## Why a script and not the product's own ingest
 *
 * The product accepts `.xlsx` (`flattenWorkbook` → the extraction agent), and that is the right
 * path for a document that only implies its structure. This workbook does not imply it: it states
 * exact keys, types, scale bounds, per-point labels, weights, required flags and guidelines, in
 * columns. Putting an LLM between that and the database can only lose fidelity — a re-derived key
 * that differs by one character silently breaks every routing rule that names it.
 *
 * So: extraction where structure must be inferred, this where it is declared.
 *
 * ## What it maps
 *
 * | Workbook            | ConQuest                                                              |
 * | ------------------- | --------------------------------------------------------------------- |
 * | Questions tab       | sections + question slots (keys, types, likert bounds + labels, weight) |
 * | ASK RULE column     | the topic's PHASE — opening / core / conditional / closing            |
 * | Routing tab         | each conditional topic's plain-English `criteria`, in the author's words |
 * | Guardrails G01      | `adaptiveScope.maxConditionalTopics = 3`                              |
 * | Guardrails G02      | a hard rule: `not_exists commercial_outcome` → EXCLUDE AI & Automation |
 * | Guardrails G04      | `includeCheckTopic` + `checkTopicPreference = [data, management]`      |
 * | Routing R12         | `fallbackTopicKeys = [business_execution, data, management]`           |
 * | Question 0.5        | `adaptiveScope.announce` — see {@link HANDOFF_KEY}                     |
 * | Guardrails G03, G05 | NOT built — reported at the end as what this instrument still needs    |
 *
 * Idempotent by refusal: it will not touch an existing Merlin5 questionnaire unless `--replace` is
 * passed, which deletes it first. Overwriting a launched instrument that has respondent sessions is
 * not something a convenience script should be able to do by accident.
 */

import { readFile } from 'node:fs/promises';

import ExcelJS from 'exceljs';

import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import {
  DEFAULT_SECONDS_PER_DATA_SLOT,
  type AdaptiveScopeSettings,
  type ScopeRule,
} from '@/lib/app/questionnaire/scope/types';

/* -------------------------------------------------------------------------- */
/* The mapping                                                                */
/* -------------------------------------------------------------------------- */

const TITLE = 'Merlin5 Growth Assessor™';

/**
 * The workbook's bot-script row (0.5), which is NOT persisted as a question.
 *
 * It is the handoff line — "based on what you've said I want to go deeper on [named sections]" —
 * and the platform already owns that moment: the Scope Planner writes the sentence and
 * `adaptiveScope.announce` delivers it in the interviewer's own voice on the turn after the plan is
 * decided. Storing it as a question would put a second, static copy of the same script in front of
 * the respondent, one of which could not name the sections because nothing had chosen them yet.
 */
const HANDOFF_KEY = 'opening_handoff';

/** Workbook `TYPE` → `AppQuestionSlot.type`. */
const TYPE_MAP: Record<string, string> = {
  Likert: 'likert',
  'Free text': 'free_text',
  Open: 'free_text',
};

/** Topic key per section number. Stable slugs — rules and plans address topics by these. */
const TOPIC_KEYS: Record<number, string> = {
  0: 'opening',
  1: 'growth_strategy',
  2: 'product_alignment',
  3: 'sales_channels',
  4: 'process_framework',
  5: 'account_planning',
  6: 'lead_generation',
  7: 'deal_management',
  8: 'pipeline_management',
  9: 'forecasting',
  10: 'management',
  11: 'talent',
  12: 'data',
  13: 'business_execution',
  14: 'ai_automation',
  15: 'top_3_things',
};

/** Workbook `ASK RULE` → topic phase. */
const PHASE_BY_ASK_RULE: Record<string, 'opening' | 'core' | 'conditional' | 'closing'> = {
  'Opening — always': 'opening',
  'Always — spine': 'core',
  Routed: 'conditional',
  'Close — always': 'closing',
};

/**
 * The data slots the opening fills — the ONLY thing the Scope Planner and the hard rules can read.
 *
 * Seeded rather than AI-generated because they are load-bearing for routing: `isOpeningComplete`
 * waits on the opening topic's data-slot keys, and G02's veto tests `commercial_outcome` by name. A
 * generated set would name them something else every run, and every rule would stop matching.
 *
 * `commercial_outcome` is deliberately separate from `growth_goals` even though both draw on 0.2.
 * G02 turns on whether the respondent named a commercial outcome they want a tool to move — a
 * distinct fact from what their goals are, and one the extractor has to be able to leave EMPTY for
 * the veto to fire.
 */
const OPENING_DATA_SLOTS: {
  key: string;
  name: string;
  description: string;
  theme: string;
  questionKeys: string[];
}[] = [
  {
    key: 'situation',
    name: 'Sales organisation today',
    description:
      'Size, shape and route to market — headcount, direct vs partner, segments. Filled when they have described the organisation factually.',
    theme: 'Opening',
    questionKeys: ['opening_situation'],
  },
  {
    key: 'growth_goals',
    name: 'What growth must deliver',
    description:
      'What the organisation must deliver in 12 months that it is not delivering now. Filled when the growth SOURCE is discernible — new logo acquisition versus expansion of the existing base.',
    theme: 'Opening',
    questionKeys: ['opening_goals'],
  },
  {
    key: 'challenges',
    name: 'What is making it hard',
    description:
      'The obstacles in their own words. The primary routing input — filled when there is operating detail, not just a financial restatement.',
    theme: 'Opening',
    questionKeys: ['opening_challenges'],
  },
  {
    key: 'impact_of_inaction',
    name: 'Cost of nothing changing',
    description:
      'Where the number lands if nothing changes. Commercial framing. Creates the stake the closing recommendation is held against.',
    theme: 'Opening',
    questionKeys: ['opening_impact'],
  },
  {
    key: 'commercial_outcome',
    name: 'Commercial outcome named',
    description:
      'A specific commercial result the respondent wants tooling, automation or AI to move — pipeline, cycle time, win rate, cost to serve. LEAVE THIS EMPTY unless they named one: an empty value is what stops the AI & Automation section being scored for someone with no underlying problem (guardrail G02).',
    theme: 'Opening',
    questionKeys: ['opening_goals', 'opening_challenges'],
  },
];

/** Guardrail G02, as a deterministic veto rather than prose the planner might not obey. */
const G02_RULE: ScopeRule = {
  id: 'g02-ai-needs-outcome',
  dataSlotKey: 'commercial_outcome',
  operator: 'not_exists',
  value: null,
  action: 'exclude',
  topicKey: 'ai_automation',
  ordinal: 0,
};

/**
 * Guidance the planner gets that no single topic's criteria can carry.
 *
 * Everything here is a cross-topic judgement from the Routing and Guardrails tabs. The hard
 * constraints (the cap, the veto, the fallback) are deliberately NOT repeated: they are enforced
 * after the model answers, and restating them here would only teach it that they are negotiable.
 */
const PLANNER_INSTRUCTIONS = [
  'Growth source is the highest-value signal and the two readings are mutually exclusive in practice: new-business language (new logo, acquisition, hunting, market share) versus existing-base language (expansion, cross-sell, upsell, renewals, churn, NRR, wallet share). If both appear in the goals answer, take the one they named FIRST.',
  'Management inconsistency is often stated as a people problem when it is a management-system problem. Route on it even when the signal is weak.',
  'Do not treat the word "AI" on its own as a signal. Nobody states "we do not use enough AI" as a challenge — it surfaces as a solution-shaped goal or a description of their stack.',
  'When the answers are abstract, hedged, or purely financial with no operating detail, prefer the areas that are the commonest unstated root causes over guessing at a specific one.',
].join('\n');

/* -------------------------------------------------------------------------- */
/* Workbook reading                                                           */
/* -------------------------------------------------------------------------- */

interface QuestionRow {
  sectionNumber: number;
  sectionTitle: string;
  questionNumber: string;
  key: string;
  prompt: string;
  type: string;
  askRule: string;
  required: boolean;
  weight: number;
  options: string;
  constraint: string;
  guidelines: string;
}

interface RoutingRow {
  ruleId: string;
  signal: string;
  listenFor: string;
  askedIn: string;
  routeTo: string;
  priority: string;
  notes: string;
}

/**
 * Flatten one cell to plain text.
 *
 * Exhaustive over the shapes exceljs actually hands back rather than falling through to
 * `String(value)`: a formula, hyperlink or error cell would stringify to `[object Object]`, which
 * would be silently written into a question prompt. Anything unrecognised yields `''` instead, so a
 * surprise shape shows up as an obviously-missing value rather than as noise a reader might trust.
 */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return '';
  if ('richText' in value) return (value.richText ?? []).map((r) => r.text).join('');
  // A hyperlink cell carries its display text; a formula cell carries its computed `result`.
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('result' in value) return cellText(value.result);
  return '';
}

/** Read a sheet as objects keyed by its header row. */
function readSheet(ws: ExcelJS.Worksheet): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const header: string[] = [];
  ws.eachRow((row, index) => {
    const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
    if (index === 1) {
      header.push(...values);
      return;
    }
    if (values.every((v) => v.trim() === '')) return;
    const record: Record<string, string> = {};
    header.forEach((h, i) => {
      record[h] = values[i] ?? '';
    });
    rows.push(record);
  });
  return rows;
}

/**
 * Parse the workbook's `OPTIONS` string into per-point likert labels.
 *
 * `"1 — Not at all | 2 — To a small extent | …"` → `['Not at all', 'To a small extent', …]`. The
 * numeric prefix is dropped: `labels[i]` describes `min + i` positionally, so carrying the number
 * into the label would render "1 — 1 — Not at all" on the respondent surface.
 */
function parseLikertLabels(options: string): string[] {
  return options
    .split('|')
    .map((part) => part.replace(/^\s*\d+\s*[—–-]\s*/, '').trim())
    .filter((part) => part.length > 0);
}

/** `"Scale 1 to 5"` → `{ min: 1, max: 5 }`. */
function parseScale(constraint: string): { min: number; max: number } | null {
  const match = constraint.match(/(\d+)\s*to\s*(\d+)/i);
  if (!match?.[1] || !match[2]) return null;
  return { min: Number(match[1]), max: Number(match[2]) };
}

/** `"6 Lead Generation; 3 Sales Channels"` → `[6, 3]`. */
function parseRouteTargets(routeTo: string): number[] {
  return routeTo
    .split(';')
    .map((part) => part.trim().match(/^(\d+)/)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
}

/**
 * Compose one conditional topic's criteria from every routing rule that targets its section.
 *
 * Written in the AUTHOR's words — the SIGNAL, their own "listen for" vocabulary, and any note they
 * attached — rather than paraphrased. The planner weighs criteria above its own general judgement,
 * so the closer this is to what the client wrote, the closer the routing is to what they specified.
 *
 * Rules are joined with "OR" because the Routing tab is a tally, not a chain: a section targeted by
 * three rules is worth asking about if ANY of them fired, and the more that fire the stronger the
 * case. Saying so explicitly is what stops the planner reading a multi-rule section as needing all
 * of them.
 */
function composeCriteria(sectionNumber: number, routing: RoutingRow[]): string | null {
  const matching = routing.filter(
    (r) =>
      r.priority.toLowerCase() !== 'fallback' &&
      parseRouteTargets(r.routeTo).includes(sectionNumber)
  );
  if (matching.length === 0) return null;

  const clauses = matching.map((rule) => {
    const listen = rule.listenFor.trim();
    const note = rule.notes.trim();
    return [
      `${rule.signal.trim()} (${rule.priority.toLowerCase()} priority) — they said something like: ${listen}.`,
      note ? ` ${note}` : '',
    ].join('');
  });

  const opener =
    matching.length === 1
      ? 'Include this when the opening shows:'
      : `Include this when the opening shows ANY of the following — the more that apply, the stronger the case:`;
  return [opener, ...clauses.map((c) => `• ${c}`)].join('\n');
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

function log(message: string) {
  console.log(message);
}

async function main() {
  const path = process.argv[2];
  const replace = process.argv.includes('--replace');
  if (!path || path.startsWith('--')) {
    console.error(
      'Usage: npm run author:merlin5 -- <path-to-Merlin5_Growth_Assessor_Question_Set_v3.xlsx> [--replace]'
    );
    process.exitCode = 1;
    return;
  }

  const workbook = new ExcelJS.Workbook();
  // `readFile` hands back a Buffer over a plain ArrayBuffer, which exceljs's typings do not accept;
  // the bytes are identical, so re-wrap rather than widen the call site's type.
  const bytes = await readFile(path);
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);

  const questionsSheet = workbook.getWorksheet('Questions');
  const routingSheet = workbook.getWorksheet('Routing');
  if (!questionsSheet || !routingSheet) {
    throw new Error(
      'Workbook is missing a "Questions" or "Routing" sheet — is this the right file?'
    );
  }

  const questions: QuestionRow[] = readSheet(questionsSheet).map((r) => ({
    sectionNumber: Number(r['SECTION NUMBER']),
    sectionTitle: r['SECTION TITLE'] ?? '',
    questionNumber: r['QUESTION NUMBER'] ?? '',
    key: (r['KEY'] ?? '').trim(),
    prompt: (r['PROMPT'] ?? '').trim(),
    type: (r['TYPE'] ?? '').trim(),
    askRule: (r['ASK RULE'] ?? '').trim(),
    required: (r['REQUIRED'] ?? '').trim().toLowerCase() === 'yes',
    weight: Number(r['WEIGHT'] ?? 0.5),
    options: r['OPTIONS'] ?? '',
    constraint: r['CONSTRAINT'] ?? '',
    guidelines: (r['GUIDELINES'] ?? '').trim(),
  }));

  const routing: RoutingRow[] = readSheet(routingSheet).map((r) => ({
    ruleId: r['RULE ID'] ?? '',
    signal: r['SIGNAL'] ?? '',
    listenFor: r['LISTEN FOR'] ?? '',
    askedIn: r['ASKED IN'] ?? '',
    routeTo: r['ROUTE TO'] ?? '',
    priority: r['PRIORITY'] ?? '',
    notes: r['NOTES'] ?? '',
  }));

  const asked = questions.filter((q) => q.key !== HANDOFF_KEY);
  log(
    `📖 Read ${questions.length} rows (${asked.length} askable) and ${routing.length} routing rules`
  );

  const existing = await prisma.appQuestionnaire.findFirst({
    where: { title: TITLE },
    select: { id: true },
  });
  if (existing && !replace) {
    console.error(
      `❌ "${TITLE}" already exists (${existing.id}). Re-run with --replace to delete and re-author it.`
    );
    process.exitCode = 1;
    return;
  }
  if (existing) {
    await prisma.appQuestionnaire.delete({ where: { id: existing.id } });
    log(`🗑  Replaced the existing questionnaire (${existing.id})`);
  }

  const versionId = await executeTransaction(async (tx) => {
    const questionnaire = await tx.appQuestionnaire.create({
      data: { title: TITLE, status: 'draft' },
      select: { id: true },
    });
    const version = await tx.appQuestionnaireVersion.create({
      data: {
        questionnaireId: questionnaire.id,
        versionNumber: 1,
        status: 'draft',
        goal: 'Diagnose where a sales organisation’s growth is constrained, and produce a scored, prioritised view of what to fix first — covering only the areas the respondent’s own account points at.',
        audience: jsonInput({
          description:
            'Sales leaders and their direct reports in B2B organisations — the people accountable for the number.',
          role: 'Sales leadership',
        }),
        goalProvenance: 'admin-supplied',
      },
      select: { id: true },
    });

    // ── Sections and questions ────────────────────────────────────────────────────────────────
    const sectionIdByNumber = new Map<number, string>();
    const seen = new Set<number>();
    for (const q of questions) {
      if (seen.has(q.sectionNumber)) continue;
      seen.add(q.sectionNumber);
      const section = await tx.appQuestionnaireSection.create({
        data: { versionId: version.id, ordinal: q.sectionNumber, title: q.sectionTitle },
        select: { id: true },
      });
      sectionIdByNumber.set(q.sectionNumber, section.id);
    }

    await tx.appQuestionSlot.createMany({
      data: asked.map((q, index) => {
        const scale = q.type === 'Likert' ? parseScale(q.constraint) : null;
        const labels = q.type === 'Likert' ? parseLikertLabels(q.options) : [];
        return {
          versionId: version.id,
          sectionId: sectionIdByNumber.get(q.sectionNumber) as string,
          ordinal: index,
          key: q.key,
          prompt: q.prompt,
          type: TYPE_MAP[q.type] ?? 'free_text',
          required: q.required,
          // The workbook's own weights: 0 for the opening, 0.5 for everything scored. A 0 weight is
          // below the admin slider's 0.1 floor and that is exactly the point — it drops the opening
          // out of the weighted-coverage denominator, so four unscored routing questions cannot
          // make a complete interview look incomplete.
          weight: q.weight,
          ...(q.guidelines ? { guidelines: q.guidelines } : {}),
          ...(scale ? { typeConfig: jsonInput({ min: scale.min, max: scale.max, labels }) } : {}),
        };
      }),
    });

    const slotIdByKey = new Map(
      (
        await tx.appQuestionSlot.findMany({
          where: { versionId: version.id },
          select: { id: true, key: true },
        })
      ).map((s) => [s.key, s.id])
    );

    // ── Opening data slots — what the planner and the rules actually read ─────────────────────
    for (const [index, slot] of OPENING_DATA_SLOTS.entries()) {
      const created = await tx.appDataSlot.create({
        data: {
          versionId: version.id,
          key: slot.key,
          name: slot.name,
          description: slot.description,
          theme: slot.theme,
          ordinal: index,
        },
        select: { id: true },
      });
      await tx.appDataSlotQuestion.createMany({
        data: slot.questionKeys
          .map((qk) => slotIdByKey.get(qk))
          .filter((id): id is string => Boolean(id))
          .map((questionSlotId) => ({ dataSlotId: created.id, questionSlotId })),
      });
    }

    // ── Topics — one per section, phase from the ASK RULE column ──────────────────────────────
    const bySection = new Map<number, QuestionRow[]>();
    for (const q of asked) {
      const list = bySection.get(q.sectionNumber) ?? [];
      list.push(q);
      bySection.set(q.sectionNumber, list);
    }

    const sectionNumbers = [...bySection.keys()].sort((a, b) => a - b);
    await tx.appQuestionnaireTopic.createMany({
      data: sectionNumbers.map((n, ordinal) => {
        const rows = bySection.get(n) ?? [];
        const first = rows[0];
        const phase = PHASE_BY_ASK_RULE[first?.askRule ?? ''] ?? 'core';
        const criteria = phase === 'conditional' ? composeCriteria(n, routing) : null;
        return {
          versionId: version.id,
          key: TOPIC_KEYS[n] ?? `section_${n}`,
          label: first?.sectionTitle ?? `Section ${n}`,
          phase,
          criteria,
          depth: 'full',
          members: jsonInput({
            questionKeys: rows.map((r) => r.key),
            // Only the opening owns data slots; every other topic is questions alone, which is what
            // keeps the planner reading the opening and nothing else.
            dataSlotKeys: n === 0 ? OPENING_DATA_SLOTS.map((s) => s.key) : [],
          }),
          ordinal,
          source: 'manual',
        };
      }),
    });

    // ── Adaptive Scope settings — the Guardrails tab, as configuration ────────────────────────
    const settings: AdaptiveScopeSettings = {
      enabled: true,
      // G01, as the workbook actually derives it: a 600-second session, from which the mandatory
      // floor (S0 + S1 + S4 + S15) is spent before any routing decision, leaving ~334s. The count
      // below is kept as the breadth ceiling it always was — the two constraints answer different
      // questions, and three topics is not a length.
      sessionBudgetSeconds: 600,
      // Default per-type estimates already carry the workbook's own anchors (8s likert, 45s free
      // text), so this version needs no override.
      secondsPerQuestionType: {},
      secondsPerDataSlot: DEFAULT_SECONDS_PER_DATA_SLOT,
      maxConditionalTopics: 3,
      // G04.
      includeCheckTopic: true,
      checkTopicPreference: ['data', 'management'],
      minConfidence: 0.6,
      // R12's fallback path, in its stated order.
      fallbackTopicKeys: ['business_execution', 'data', 'management'],
      // Script 0.5.
      announce: true,
      allowRespondentAmendment: true,
      plannerInstructions: PLANNER_INSTRUCTIONS,
      // G02.
      rules: [G02_RULE],
    };

    await tx.appQuestionnaireConfig.create({
      data: {
        versionId: version.id,
        selectionStrategy: 'adaptive',
        // The scored items are meant to be fast — "first instinct is usually right" — so the
        // interviewer should not probe them the way it probes an open answer.
        coverageThreshold: 0.9,
        adaptiveScope: jsonInput(settings),
      },
    });

    return version.id;
  });

  log(`✅ Authored "${TITLE}" — version ${versionId}`);
  log(
    `   ${asked.length} questions across ${new Set(asked.map((q) => q.sectionNumber)).size} sections`
  );
  log(
    `   ${OPENING_DATA_SLOTS.length} opening data slots · ${Object.keys(TOPIC_KEYS).length} topics`
  );
  log('');
  log(
    '   Adaptive Scope is ON: cap 3 (G01) · blind-spot check preferring Data then Management (G04)'
  );
  log('   · fallback Business Execution / Data / Management (R12) · G02 as a deterministic veto');
  log('');
  log(`⚠️  Not expressible today, and deliberately not faked:`);
  log('   G03 (one probe maximum across the opening) — there is no per-session probe budget.');
  log('   G05 (hold the close against the opening) — the report has no open-vs-close comparison.');
  log('   G06 (normalise 1–6 against 1–5) — scoring has no cross-scale normalisation, so do not');
  log('        build a composite across Section 14 and the rest until it does.');
  log('   The 10-minute time budget — the cap is a topic COUNT, not seconds (research doc §C7).');
}

main()
  .catch((err) => {
    console.error('❌ authoring failed', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
