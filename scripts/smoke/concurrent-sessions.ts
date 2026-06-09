/**
 * Concurrent-session sanity smoke script (F9.1 production hardening)
 *
 * Drives the live respondent **persistence seams** under concurrency against the real
 * Postgres dev DB, to prove the three invariants F9.1 names:
 *
 *   - **no deadlocks** — N sessions create + turn + complete concurrently with no rejected
 *     promise / Postgres deadlock (40P01) / serialization failure;
 *   - **no orphan turns** — every persisted turn maps to a live session, every session has
 *     exactly the turns it drove, and ordinals are contiguous 1..K per session;
 *   - **no missed audit writes** — every session has its `created` + `completed`
 *     `AppQuestionnaireSessionEvent`, every answered slot is back-stamped with a real turn
 *     id, and the answer-slot count reconciles per session.
 *
 * Seams exercised (the concurrency-sensitive write paths, all `$transaction`-based):
 *   - `createAnonymousSession`  → session row + `created` event (one tx)
 *   - `persistTurn` (turn-run.ts) → `AppQuestionnaireTurn` + `AppAnswerSlot` upsert +
 *      `lastUpdatedTurnId` back-stamp (one tx), the real live-turn write path
 *   - `markSessionCompleted`    → status update + `completed` event (one tx)
 *
 * **LLM is stubbed by construction, not by a fake provider.** The orchestrator's paid
 * compute (extraction/refinement/contradiction LLM calls) only *produces* the
 * `AnswerSlotIntent`s that `persistTurn` writes; this script feeds `persistTurn` those
 * intents directly — deterministic, free, no network — so the test isolates the DB
 * concurrency surface the invariants are actually about. (The other smoke scripts stub via
 * `registerProviderInstance`; here there is no LLM in the loop to stub.)
 *
 * Modes:
 *   - default            → 24 concurrent sessions × 4 turns each (concurrency sanity).
 *   - `--single` / `-1`  → one session, verbose per-stage logging + a results-export read
 *      (F8.2) — the F9.1 "final happy-path integration pass" stitched journey.
 *
 * Safety:
 *   - Everything hangs off ONE `smoke-test-f91` AppQuestionnaire; deleting it cascades to
 *     versions, config, sections, slots, sessions, answers, events, and turns. Stale rows
 *     from a prior run are removed before seeding and after the run. Never touches any
 *     other data; no destructive global commands. Read `scripts/smoke/README.md` first.
 *
 * Run with:
 *   npm run smoke:concurrent-sessions
 *   npm run smoke:concurrent-sessions -- --single
 *   # or:
 *   npx tsx --env-file=.env.local scripts/smoke/concurrent-sessions.ts
 */

import { prisma } from '@/lib/db/client';
import { createAnonymousSession } from '@/app/api/v1/app/questionnaire-sessions/_lib/create';
import { persistTurn } from '@/app/api/v1/app/questionnaire-sessions/_lib/turn-run';
import {
  markSessionCompleted,
  loadSessionResumeState,
} from '@/app/api/v1/app/questionnaires/_lib/sessions';
import { loadResultsExport } from '@/lib/app/questionnaire/export/results-loader';
import { toResultsCsv } from '@/lib/app/questionnaire/export/results-serialize';
import type { AnalyticsScope } from '@/lib/app/questionnaire/analytics';
import type { AnswerSlotIntent } from '@/lib/app/questionnaire/extraction/types';
import type { ToolCallRecord } from '@/lib/app/questionnaire/orchestrator';

const MARKER = 'smoke-test-f91';
const QUESTIONNAIRE_TITLE = `${MARKER} concurrent sessions`;

const SESSIONS = 24; // "20+ concurrent-session sanity test"
const SLOT_COUNT = 4; // questions per version
const TURNS_PER_SESSION = SLOT_COUNT; // one answered slot per turn

/** A failure detail collected during the run; a non-empty list fails the smoke. */
const failures: string[] = [];
function fail(msg: string): void {
  failures.push(msg);
  console.error(`    ✗ ${msg}`);
}

/** The seeded version graph the run drives against. */
interface SeededVersion {
  questionnaireId: string;
  versionId: string;
  /** slotKey → { id, type } for the persistTurn intent mapping. */
  slots: { key: string; id: string }[];
}

/** Delete any AppQuestionnaire(s) left by a previous run — cascade clears the whole graph. */
async function cleanupStale(): Promise<void> {
  const stale = await prisma.appQuestionnaire.findMany({
    where: { title: QUESTIONNAIRE_TITLE },
    select: { id: true },
  });
  if (stale.length === 0) return;
  await prisma.appQuestionnaire.deleteMany({ where: { title: QUESTIONNAIRE_TITLE } });
  console.log(`    cleaned up ${stale.length} stale ${MARKER} questionnaire(s)`);
}

/** Seed a launched, anonymous-mode version with SLOT_COUNT free-text questions. */
async function seed(): Promise<SeededVersion> {
  const questionnaire = await prisma.appQuestionnaire.create({
    data: {
      title: QUESTIONNAIRE_TITLE,
      status: 'launched',
      versions: {
        create: {
          versionNumber: 1,
          status: 'launched',
          // anonymousMode = true so createAnonymousSession is permitted (no-login surface).
          config: { create: { anonymousMode: true, selectionStrategy: 'sequential' } },
          sections: {
            create: {
              ordinal: 1,
              title: `${MARKER} section`,
              questions: {
                create: Array.from({ length: SLOT_COUNT }, (_, i) => ({
                  versionId: '', // set below — denormalised FK needs the version id
                  ordinal: i + 1,
                  key: `${MARKER}-q${i + 1}`,
                  prompt: `Smoke question ${i + 1}?`,
                  type: 'free_text',
                  required: true,
                })),
              },
            },
          },
        },
      },
    },
    select: {
      id: true,
      versions: { select: { id: true } },
    },
  });

  const versionId = questionnaire.versions[0].id;

  // AppQuestionSlot.versionId is a denormalised FK Prisma's nested create can't backfill in
  // one shot — stamp it now so slot lookups by version work.
  await prisma.appQuestionSlot.updateMany({
    where: { section: { versionId } },
    data: { versionId },
  });

  const slots = await prisma.appQuestionSlot.findMany({
    where: { versionId },
    orderBy: { ordinal: 'asc' },
    select: { id: true, key: true },
  });

  return { questionnaireId: questionnaire.id, versionId, slots };
}

/** The deterministic extraction intent the orchestrator would have produced for one slot. */
function intentForSlot(slotKey: string, turnIndex: number): AnswerSlotIntent {
  return {
    slotKey,
    questionType: 'free_text',
    value: `answer-${turnIndex}`,
    confidence: 0.9,
    provenance: 'direct',
    rationale: 'smoke deterministic answer',
    isActiveQuestion: true,
  };
}

/** Run TURNS_PER_SESSION sequential turns over one session (ordinal depends on count). */
async function runSession(sessionId: string, seeded: SeededVersion): Promise<void> {
  const keyToSlotId = new Map(seeded.slots.map((s) => [s.key, s.id]));
  for (let t = 0; t < TURNS_PER_SESSION; t++) {
    const slot = seeded.slots[t];
    const toolCalls: ToolCallRecord[] = [{ slug: 'extract_answer_slots', success: true }];
    await persistTurn({
      sessionId,
      userMessage: `respondent message ${t + 1}`,
      agentResponse: `agent reply ${t + 1}`,
      targetedQuestionId: slot.id,
      toolCalls,
      costUsd: 0.001,
      upserts: [intentForSlot(slot.key, t + 1)],
      refinements: [],
      keyToSlotId,
    });
  }
  await markSessionCompleted(sessionId);
}

/** Assert the three invariants over the persisted graph for the given session ids. */
async function verify(seeded: SeededVersion, sessionIds: string[]): Promise<void> {
  const sessions = await prisma.appQuestionnaireSession.findMany({
    where: { versionId: seeded.versionId, isPreview: false },
    select: {
      id: true,
      status: true,
      turns: { select: { id: true, ordinal: true }, orderBy: { ordinal: 'asc' } },
      answers: { select: { id: true, lastUpdatedTurnId: true } },
      events: { select: { eventType: true } },
    },
  });

  // No orphan/extra sessions.
  if (sessions.length !== sessionIds.length) {
    fail(`expected ${sessionIds.length} sessions, found ${sessions.length}`);
  }

  const allTurnIds = new Set<string>();
  for (const s of sessions) {
    // Completed status (markSessionCompleted ran).
    if (s.status !== 'completed')
      fail(`session ${s.id} status is "${s.status}", expected completed`);

    // No orphan turns: exactly TURNS_PER_SESSION, ordinals contiguous 1..K.
    if (s.turns.length !== TURNS_PER_SESSION) {
      fail(`session ${s.id} has ${s.turns.length} turns, expected ${TURNS_PER_SESSION}`);
    }
    s.turns.forEach((turn, i) => {
      if (turn.ordinal !== i + 1)
        fail(`session ${s.id} turn #${i} ordinal=${turn.ordinal}, expected ${i + 1}`);
      allTurnIds.add(turn.id);
    });

    // Answer-slot reconciliation: one answer per slot, each back-stamped with a real turn.
    if (s.answers.length !== SLOT_COUNT) {
      fail(`session ${s.id} has ${s.answers.length} answers, expected ${SLOT_COUNT}`);
    }
    const sessionTurnIds = new Set(s.turns.map((t) => t.id));
    for (const a of s.answers) {
      if (!a.lastUpdatedTurnId) {
        fail(`session ${s.id} answer ${a.id} has no lastUpdatedTurnId (missed turn back-stamp)`);
      } else if (!sessionTurnIds.has(a.lastUpdatedTurnId)) {
        fail(
          `session ${s.id} answer ${a.id} back-stamped with foreign turn ${a.lastUpdatedTurnId}`
        );
      }
    }

    // No missed audit writes: exactly one `created` and one `completed` event.
    const created = s.events.filter((e) => e.eventType === 'created').length;
    const completed = s.events.filter((e) => e.eventType === 'completed').length;
    if (created !== 1) fail(`session ${s.id} has ${created} created events, expected 1`);
    if (completed !== 1) fail(`session ${s.id} has ${completed} completed events, expected 1`);
  }

  // No orphan turns globally: every turn belongs to one of our sessions (no extras/dupes).
  const totalTurns = await prisma.appQuestionnaireTurn.count({
    where: { session: { versionId: seeded.versionId } },
  });
  const expectedTurns = sessionIds.length * TURNS_PER_SESSION;
  if (totalTurns !== expectedTurns) {
    fail(`total turns=${totalTurns}, expected ${expectedTurns} (orphan or dropped turns)`);
  }
  if (allTurnIds.size !== expectedTurns) {
    fail(`distinct turn ids=${allTurnIds.size}, expected ${expectedTurns}`);
  }

  console.log(
    `    ✓ ${sessions.length} sessions · ${totalTurns} turns · audit events + answer back-stamps reconciled`
  );
}

/** The F9.1 happy-path stitched journey: one session, verbose, plus a results-export read. */
async function runHappyPath(seeded: SeededVersion): Promise<void> {
  console.log('\n[journey] single happy-path session');
  const create = await createAnonymousSession(seeded.versionId);
  if (!create.ok) {
    fail(`createAnonymousSession failed: ${create.code} ${create.message}`);
    return;
  }
  const sessionId = create.session.id;
  console.log(`  • created session ${sessionId} (status=${create.session.status})`);

  await runSession(sessionId, seeded);
  console.log(`  • ran ${TURNS_PER_SESSION} turns + completed`);

  const resume = await loadSessionResumeState(sessionId);
  console.log(
    `  • resume state: status=${resume.status}, ${resume.answeredSlots.length} answers captured`
  );
  if (resume.status !== 'completed')
    fail(`journey session status=${resume.status}, expected completed`);
  if (resume.answeredSlots.length !== SLOT_COUNT) {
    fail(`journey captured ${resume.answeredSlots.length} answers, expected ${SLOT_COUNT}`);
  }

  // F8.2 results export — the journey's final stage. Wide window to capture the just-completed session.
  const scope: AnalyticsScope = {
    versionId: seeded.versionId,
    from: new Date('2000-01-01T00:00:00.000Z'),
    to: new Date('2999-01-01T00:00:00.000Z'),
    tagIds: [],
  };
  const exportModel = await loadResultsExport(scope);
  if (!exportModel) {
    fail('loadResultsExport returned null for the seeded version');
    return;
  }
  const csv = toResultsCsv(exportModel);
  const csvRows = csv.trim().split('\n').length - 1; // minus header
  console.log(
    `  • export: ${exportModel.sessions.length} session(s), ${exportModel.questions.length} questions, ${csvRows} CSV row(s)`
  );
  if (exportModel.sessions.length < 1) fail('export has no completed sessions');
}

async function main(): Promise<void> {
  const single = process.argv.includes('--single') || process.argv.includes('-1');

  console.log(`\n[1] cleanup stale ${MARKER} rows`);
  await cleanupStale();

  console.log('[2] seed launched anonymous-mode version');
  const seeded = await seed();
  console.log(
    `    questionnaire ${seeded.questionnaireId} · version ${seeded.versionId} · ${seeded.slots.length} slots`
  );

  if (single) {
    await runHappyPath(seeded);
  } else {
    console.log(`\n[3] create ${SESSIONS} sessions concurrently`);
    const creates = await Promise.allSettled(
      Array.from({ length: SESSIONS }, () => createAnonymousSession(seeded.versionId))
    );
    const sessionIds: string[] = [];
    creates.forEach((r, i) => {
      if (r.status === 'rejected') {
        fail(`session create #${i} rejected: ${String(r.reason)}`);
      } else if (!r.value.ok) {
        fail(`session create #${i} failed: ${r.value.code} ${r.value.message}`);
      } else {
        sessionIds.push(r.value.session.id);
      }
    });
    console.log(`    ✓ ${sessionIds.length}/${SESSIONS} sessions created`);

    console.log(`[4] run ${TURNS_PER_SESSION} turns × ${sessionIds.length} sessions concurrently`);
    const runs = await Promise.allSettled(sessionIds.map((id) => runSession(id, seeded)));
    runs.forEach((r, i) => {
      if (r.status === 'rejected') {
        // A Postgres deadlock (40P01) or serialization failure surfaces here.
        fail(`session run #${i} (${sessionIds[i]}) rejected: ${String(r.reason)}`);
      }
    });
    console.log(
      `    ✓ ${runs.filter((r) => r.status === 'fulfilled').length}/${runs.length} session runs settled`
    );

    console.log('[5] verify invariants (no deadlocks / orphan turns / missed audit writes)');
    await verify(seeded, sessionIds);
  }

  console.log('\n[6] cleanup (scoped — cascade from the seeded questionnaire)');
  const deleted = await prisma.appQuestionnaire.deleteMany({
    where: { id: seeded.questionnaireId },
  });
  console.log(`    deleted ${deleted.count} questionnaire (cascade cleared the graph)`);

  await prisma.$disconnect();

  if (failures.length > 0) {
    console.error(`\n✗ smoke FAILED with ${failures.length} invariant violation(s)`);
    process.exit(1);
  }
  console.log('\n✓ concurrent-session smoke passed');
}

main().catch(async (err) => {
  console.error('\n✗ smoke script failed:', err);
  try {
    await prisma.appQuestionnaire.deleteMany({ where: { title: QUESTIONNAIRE_TITLE } });
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
