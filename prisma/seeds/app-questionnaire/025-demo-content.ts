// DEMO-ONLY (F9.4): sample demo client + a fully launched, attributed questionnaire
// so the F9.2 operational runbook can be road-tested end-to-end without any manual
// admin clicks. This whole file is demo scaffolding — a fork strips it via
// `grep -rl "DEMO-ONLY"` (see .context/app/questionnaire/forking.md). Nothing else
// imports it; the seed runner discovers it by glob, so deletion is a clean removal.
//
// Env-gated: it no-ops unless `LOAD_DEMO_CONTENT=1`, so it never loads in production.
// Idempotent: re-running replaces the demo questionnaire (keyed on a stable title)
// and upserts the demo client by slug — no duplicates.

import type { SeedUnit } from '@/prisma/runner';
import { executeTransaction } from '@/lib/db/utils';
import { assertPersistable, writeGraph } from '@/app/api/v1/app/questionnaires/_lib/persist';
import { generateAndSaveDataSlots } from '@/app/api/v1/app/questionnaires/_lib/generate-data-slots';
import { slugifyDemoClient } from '@/lib/app/questionnaire/demo-clients/slug';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import {
  DEFAULT_QUESTIONNAIRE_CONFIG,
  type AudienceProvenance,
  type AudienceShape,
} from '@/lib/app/questionnaire/types';

// DEMO-ONLY: the demo prospect. Slug is derived from the name (the admin UI does the
// same), so the client appears at /admin/demo-clients/<slug>.
const DEMO_CLIENT_NAME = 'Northwind Logistics (Demo)';
const DEMO_CLIENT = {
  name: DEMO_CLIENT_NAME,
  slug: slugifyDemoClient(DEMO_CLIENT_NAME),
  description: 'DEMO-ONLY: sample prospect for the F9.2 spin-up walkthrough.',
  isActive: true,
  // Brand snapshot the invitation email + F7.1 chat surface resolve. Valid hex /
  // absolute-https so the themed paths are visibly exercised, not defaulted away.
  // A distinct navy / blue / cyan / sky logistics palette — every theme colour is a
  // different hex so the demo exercises the full vocabulary (no field reuses another).
  ctaColor: '#2563eb', // blue CTA start
  accentColor: '#38bdf8', // sky accent (dots, user-bubble tint, progress)
  logoUrl: 'https://dummyimage.com/200x48/0b1f3a/ffffff&text=Northwind',
  welcomeCopy: 'Thanks for trialing Northwind — a few quick questions about your onboarding.',
  // F7.1+ chrome: a deep surface band, a gradient CTA (blue → cyan), and the logo on its
  // dark backdrop — so the seeded demo exercises every themed path the session renders.
  surfaceColor: '#0b1f3a', // deep navy header band
  ctaColorEnd: '#22d3ee', // cyan gradient end (distinct from the accent)
  logoBackgroundColor: '#0b1f3a', // logo sits on the navy backdrop
  logoBackgroundEnabled: true,
} as const;

// DEMO-ONLY: stable idempotency marker. The seed finds-and-replaces the questionnaire
// with this exact title on every run, so editing the sample content below refreshes
// the demo without duplicating it. (A respondent session/invitation against the prior
// launched version cascades away on replace — re-running the seed is an explicit reset.)
const DEMO_QUESTIONNAIRE_TITLE = 'Northwind Logistics — Onboarding Experience Review';

// DEMO-ONLY: the questionnaire's goal + audience. Both are required by the launch gate
// (assertLaunchable: goal set + audience has ≥1 defined field); the audience populates
// all seven AudienceShape fields so it reads like a real engagement.
const DEMO_GOAL =
  'Understand how new Northwind Logistics customers experience the first 30 days of ' +
  'onboarding, and identify the friction points that most affect early retention.';

const DEMO_AUDIENCE: AudienceShape = {
  description: 'Recently onboarded Northwind Logistics customers (first 30 days)',
  role: 'Operations / logistics coordinator',
  expertiseLevel: 'intermediate',
  estimatedDurationMinutes: 8,
  locale: 'en',
  sensitivity: 'low',
  notes: 'Demo questionnaire — not a real customer engagement.',
};

// DEMO-ONLY: every audience field was hand-authored, so mark each admin-supplied.
const DEMO_AUDIENCE_PROVENANCE: AudienceProvenance = {
  description: 'admin-supplied',
  role: 'admin-supplied',
  expertiseLevel: 'admin-supplied',
  estimatedDurationMinutes: 'admin-supplied',
  locale: 'admin-supplied',
  sensitivity: 'admin-supplied',
  notes: 'admin-supplied',
};

// DEMO-ONLY: the demo runs in anonymous mode (anonymousMode: true) so the admin can
// one-click "Preview as respondent" through the no-login public surface — no email, no
// invitation. Anonymous mode collects no profile fields (the F8.3 invariant), which suits
// an anonymous onboarding-feedback survey. To demo identified profile capture instead,
// turn anonymous mode off in the config and add profileFields.

// DEMO-ONLY: the hand-authored extraction graph (2 sections, 6 questions spanning the
// question-type range). Fed through `writeGraph` exactly as the ingestion route feeds
// the extractor's output, so the demo content takes the same persistence path as a
// real upload. `changes: []` — hand-authored content has no editorial change log.
const DEMO_EXTRACTION: ExtractQuestionnaireStructureData = {
  inferredGoal: DEMO_GOAL,
  inferredAudience: DEMO_AUDIENCE,
  changes: [],
  sections: [
    {
      ordinal: 0,
      title: 'Getting started',
      description: 'Your first experience setting up Northwind.',
    },
    {
      ordinal: 1,
      title: 'Value & support',
      description: 'Getting value and getting help.',
    },
  ],
  questions: [
    {
      sectionOrdinal: 0,
      key: 'setup_ease',
      prompt: 'How easy was it to set up your account during onboarding?',
      suggestedType: 'likert',
      suggestedTypeConfig: {
        min: 1,
        max: 5,
        labels: ['Very difficult', 'Difficult', 'Neutral', 'Easy', 'Very easy'],
      },
      extractionConfidence: 0.95,
    },
    {
      sectionOrdinal: 0,
      key: 'setup_blockers',
      prompt: 'What, if anything, slowed you down while getting started?',
      guidelines: 'Encourage a specific example rather than a yes/no answer.',
      suggestedType: 'free_text',
      extractionConfidence: 0.9,
    },
    {
      sectionOrdinal: 0,
      key: 'onboarding_channel',
      prompt: 'How did you primarily complete onboarding?',
      suggestedType: 'single_choice',
      suggestedTypeConfig: {
        choices: ['Self-serve docs', 'Guided call with a CSM', 'In-app walkthrough', 'A mix'],
      },
      extractionConfidence: 0.92,
    },
    {
      sectionOrdinal: 1,
      key: 'first_value_days',
      prompt: 'Roughly how many days passed before you got real value from Northwind?',
      suggestedType: 'numeric',
      suggestedTypeConfig: { min: 0, max: 365, unit: 'days' },
      extractionConfidence: 0.85,
    },
    {
      sectionOrdinal: 1,
      key: 'support_channels_used',
      prompt: 'Which support channels did you use in your first 30 days?',
      suggestedType: 'multi_choice',
      suggestedTypeConfig: { choices: ['Email', 'Live chat', 'Phone', 'Help center', 'None'] },
      extractionConfidence: 0.9,
    },
    {
      sectionOrdinal: 1,
      key: 'would_recommend',
      prompt: 'Based on onboarding alone, would you recommend Northwind to a peer?',
      rationale: 'Quick proxy for early-onboarding sentiment.',
      suggestedType: 'boolean',
      extractionConfidence: 0.88,
    },
  ],
};

/**
 * DEMO-ONLY (F9.4): seed a sample demo client + a launched, attributed questionnaire.
 *
 * No-ops unless `LOAD_DEMO_CONTENT=1` (the env gate lives inside `run()` so the runner
 * still stamps SeedHistory on the no-op; to load demo content on an environment that
 * previously no-op'd, set the env var AND clear the `app-questionnaire/025-demo-content`
 * SeedHistory row, since the file content is unchanged — see the F9.2 runbook).
 *
 * Builds the whole graph in one transaction so a partial demo never exists: upsert the
 * demo client → (replace any prior demo questionnaire) → questionnaire → version →
 * section/slot graph via `writeGraph` → config row → flip the version to `launched`.
 * The seed sets `status: 'launched'` directly (there is no pure launch helper — the
 * gate lives in the status HTTP route), so it re-checks the gate's invariants itself:
 * goal ✓, non-empty audience ✓, ≥1 section ✓, ≥1 question ✓, config row ✓.
 */
const unit: SeedUnit = {
  name: 'app-questionnaire/025-demo-content',
  async run({ logger }) {
    if (process.env.LOAD_DEMO_CONTENT !== '1') {
      logger.info('⏭  DEMO-ONLY: LOAD_DEMO_CONTENT!=1 — skipping demo content seed');
      return;
    }

    logger.info('🎬 DEMO-ONLY: seeding demo client + launched questionnaire...');

    // Fail fast before touching the DB if the hand-authored graph is incoherent.
    assertPersistable(DEMO_EXTRACTION);

    // Captured inside the transaction so the post-commit data-slot generation (an LLM call,
    // deliberately kept OUT of the DB transaction) can target the freshly seeded version.
    let demoQuestionnaireId = '';
    let demoVersionId = '';

    await executeTransaction(async (tx) => {
      // Demo client — upsert by unique slug (idempotent on every field).
      const demoClient = await tx.appDemoClient.upsert({
        where: { slug: DEMO_CLIENT.slug },
        update: {
          name: DEMO_CLIENT.name,
          description: DEMO_CLIENT.description,
          isActive: DEMO_CLIENT.isActive,
          ctaColor: DEMO_CLIENT.ctaColor,
          accentColor: DEMO_CLIENT.accentColor,
          logoUrl: DEMO_CLIENT.logoUrl,
          welcomeCopy: DEMO_CLIENT.welcomeCopy,
          surfaceColor: DEMO_CLIENT.surfaceColor,
          ctaColorEnd: DEMO_CLIENT.ctaColorEnd,
          logoBackgroundColor: DEMO_CLIENT.logoBackgroundColor,
          logoBackgroundEnabled: DEMO_CLIENT.logoBackgroundEnabled,
        },
        create: { ...DEMO_CLIENT },
        select: { id: true },
      });

      // Replace-on-rerun: drop any prior demo questionnaire (version/section/slot/
      // config/sessions/invitations cascade) so edits to the content above take hold
      // without duplicating.
      const existing = await tx.appQuestionnaire.findFirst({
        where: { title: DEMO_QUESTIONNAIRE_TITLE },
        select: { id: true },
      });
      if (existing) {
        await tx.appQuestionnaire.delete({ where: { id: existing.id } });
      }

      // Questionnaire attributed to the demo client at create (the UI does this via
      // a later PATCH; the seed sets it inline). Questionnaire-level status stays
      // 'draft' — the launch lifecycle is version-scoped.
      const questionnaire = await tx.appQuestionnaire.create({
        data: {
          title: DEMO_QUESTIONNAIRE_TITLE,
          status: 'draft',
          demoClientId: demoClient.id,
        },
        select: { id: true },
      });
      demoQuestionnaireId = questionnaire.id;

      // Version 1 — carries the launch-gate goal + audience (+ provenance).
      const version = await tx.appQuestionnaireVersion.create({
        data: {
          questionnaireId: questionnaire.id,
          versionNumber: 1,
          status: 'draft',
          goal: DEMO_GOAL,
          audience: DEMO_AUDIENCE,
          goalProvenance: 'admin-supplied',
          audienceProvenance: DEMO_AUDIENCE_PROVENANCE,
        },
        select: { id: true },
      });
      demoVersionId = version.id;

      // Section + slot graph — same writer the ingestion route uses.
      const counts = await writeGraph(tx, version.id, DEMO_EXTRACTION);

      // Config row — the launch gate requires the row to exist. Mirror the schema
      // defaults, overriding only the demo-relevant knobs:
      //   - anonymousMode: true — lets the admin one-click "Preview as respondent" via the
      //     no-login public surface; collects no profile fields (F8.3).
      //   - contradictionMode: 'flag' — so the chat's "I noticed something" callout fires
      //     when a respondent gives inconsistent answers (the most visible sign of the
      //     agent reasoning about the conversation).
      //   - sensitivityAwareness: true + an authored supportMessage — so a sensitive disclosure
      //     (e.g. "I'm being abused by my boss") softens the agent's tone AND signposts support
      //     once. Without an authored supportMessage the signpost is suppressed, so the demo ships
      //     verbatim copy here.
      // The contradiction / sensitivity-awareness sub-flags and the live-sessions flag (DB rows)
      // must also be on at runtime; see the runbook.
      await tx.appQuestionnaireConfig.create({
        data: {
          versionId: version.id,
          selectionStrategy: DEFAULT_QUESTIONNAIRE_CONFIG.selectionStrategy,
          minQuestionsAnswered: DEFAULT_QUESTIONNAIRE_CONFIG.minQuestionsAnswered,
          coverageThreshold: DEFAULT_QUESTIONNAIRE_CONFIG.coverageThreshold,
          costBudgetUsd: DEFAULT_QUESTIONNAIRE_CONFIG.costBudgetUsd,
          maxQuestionsPerSession: DEFAULT_QUESTIONNAIRE_CONFIG.maxQuestionsPerSession,
          voiceEnabled: DEFAULT_QUESTIONNAIRE_CONFIG.voiceEnabled,
          contradictionMode: 'flag',
          contradictionWindowN: 4,
          contradictionEveryNTurns: 1,
          anonymousMode: true,
          // Safeguarding: detect + remember a sensitive disclosure, soften later phrasing, and
          // signpost support once on a serious (high-severity) disclosure. Verbatim, admin-authored
          // copy (never LLM-reworded) so the safeguarding wording is exact.
          sensitivityAwareness: true,
          supportMessage:
            'If anything you’ve shared here has been difficult, please know you don’t have to ' +
            'deal with it alone — confidential support is available whenever you need it, and you ' +
            'can take a break or stop at any time.',
          supportResourceUrl: 'https://www.mind.org.uk/information-support/',
          answerSlotPanelScope: DEFAULT_QUESTIONNAIRE_CONFIG.answerSlotPanelScope,
          // "Animated" reasoning-stream timing — seed the defaults explicitly so the demo's open
          // duration scales with the step count (base dwell + per-step extra) out of the box.
          reasoningStreamDwellMs: DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamDwellMs,
          reasoningStreamPerItemMs: DEFAULT_QUESTIONNAIRE_CONFIG.reasoningStreamPerItemMs,
          profileFields: [],
        },
      });

      // Launch gate satisfied (goal, audience, sections, questions, config) — flip the
      // version to launched so the runbook can invite a respondent immediately.
      await tx.appQuestionnaireVersion.update({
        where: { id: version.id },
        data: { status: 'launched' },
      });

      logger.info(
        `✅ DEMO-ONLY: seeded "${DEMO_QUESTIONNAIRE_TITLE}" — ${counts.sectionCount} sections, ` +
          `${counts.questionCount} questions, launched and attributed to ${DEMO_CLIENT.slug}`
      );
    });

    // DEMO-ONLY: give the demo its data-slot abstraction so the seeded questionnaire exercises
    // the data-slots conversation, not just the raw questions. Runs the SAME generator agent the
    // admin "Generate" button uses and saves the result LIVE (no draft/review step). Deliberately
    // AFTER the transaction — it makes an LLM call, which must not run inside a DB transaction.
    //
    // Fail-soft by design: with no provider/API key configured (e.g. a bare CI or a local seed
    // without LLM creds) generation returns a non-`saved` outcome; we log it and leave the demo
    // fully usable WITHOUT slots rather than failing the seed. Re-running the seed (or the
    // `db:backfill:data-slots` script) backfills the slots once a provider is available.
    //
    // The data-slots sub-flag still has to be ON at runtime for these to surface — the F9.2
    // runbook flips it alongside the live-sessions + contradiction flags.
    const slotResult = await generateAndSaveDataSlots(demoQuestionnaireId, demoVersionId, {
      granularity: 'balanced',
    });
    if (slotResult.status === 'saved') {
      logger.info(`✅ DEMO-ONLY: generated ${slotResult.slotCount} data slots for the demo`);
    } else {
      logger.warn(
        `⚠️  DEMO-ONLY: data slots not generated (${slotResult.status}: ${slotResult.diagnostic ?? 'n/a'}). ` +
          `The demo is still usable; run "npm run db:backfill:data-slots" once an LLM provider is configured.`,
        slotResult.message ? { message: slotResult.message } : undefined
      );
    }
  },
};

export default unit;
