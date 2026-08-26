import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';
import { QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG } from '@/lib/app/questionnaire/constants';

/**
 * Seed the Conditional Topics candidacy-check agent (P17.19).
 *
 * A cheap, fast triage read that runs on every fresh questionnaire ingestion: does the uploaded
 * document's own text describe routing different respondents through different parts of it? Not
 * the Routing Analyst (`088-routing-analyst-agent.ts`) — this only decides whether that analysis is
 * worth running automatically. A ConQuest **app** agent (`isSystem: false`): editable, deletable,
 * in config backup/export.
 *
 * **The load-bearing rubric lives in code, not here.** Dispatched app-natively (a structured
 * `runStructuredCompletion` call) with the prompt built from `scope/candidacy-prompt.ts` — it does
 * NOT read these `systemInstructions`; they exist so the agent is self-describing in the admin UI.
 * **Bound explicitly to `openai/gpt-5.4-mini`, not left empty for the `routing` tier.** It used to
 * ship empty on the reasoning that a per-upload check must stay cheap, which resolved it to
 * `gpt-4.1-nano`. Measured over the routing corpus (`tests/fixtures/app/questionnaire/routing-corpus`),
 * that model returned malformed JSON on roughly one call in six; both attempts failing means the
 * ingest silently skips Conditional Topics altogether. `gpt-5.4-mini` was clean on 60 of 60 calls,
 * was the FASTEST of the five models tried (~1.6s against nano's ~2.6s), and costs $0.0009 per
 * uploaded document — a rounding error next to the extractor's $0.12 on the same upload. The
 * frontier `gpt-5.4` was measurably WORSE here (17/20) as well as six times dearer: it returns more
 * signals than the contract allows. Cheap was never the problem; the wrong tier was.
 *
 * **How a fork opts out — and the one way that does NOT work.** `update` re-asserts `isSystem` and
 * fills the binding only when BOTH fields are still empty, so any row showing a sign of operator
 * intent is left alone. Setting `provider` (with `model` empty, to keep the tier default) is
 * therefore the durable opt-out, and it is what a non-OpenAI fork would do anyway.
 *
 * Wiping both fields back to empty is NOT durable, and the distinction is easy to miss: the seed
 * runner re-runs a unit whenever its source hash changes, and "both empty" is indistinguishable
 * from "never configured", so the next `db:seed` re-imposes this binding. On an Anthropic-only
 * deployment that would dispatch candidacy to a provider with no key — and because the check is
 * fail-soft, it would fail silently. Set `provider` rather than clearing it.
 *
 * The guard is deliberately `!model && !provider` rather than `!model`: a fork that set
 * `provider: 'anthropic', model: ''` means "Anthropic, tier default", and filling just the model
 * would stamp an OpenAI id over a deliberate choice.
 */

const SLUG = QUESTIONNAIRE_SCOPE_CANDIDACY_AGENT_SLUG;

/**
 * The binding this check runs on. ConQuest is an OpenAI-default deployment, so an OpenAI id here
 * follows the same app-seed convention as `020-orchestration-default-models`; a fork on another
 * provider clears these two fields and inherits the tier default instead.
 */
const CANDIDACY_MODEL = 'gpt-5.4-mini';
const CANDIDACY_PROVIDER = 'openai';

const SYSTEM_INSTRUCTIONS = `You are a fast triage check for ConQuest's questionnaire ingestion \
pipeline. Given a freshly-uploaded document, you decide ONLY whether its own words describe routing \
different respondents through different parts of the instrument — eligibility notes, routing or \
guardrail guidance, skip logic, facilitator instructions naming who answers what, wherever in the \
file they sit and whatever the subject matter. You do not propose \
topics or rules; that is a separate analyst's job, run only when you say yes. (The exact rubric the \
engine sends is maintained in code; this description is for reference.)`;

const unit: SeedUnit = {
  name: 'app-questionnaire/089-scope-candidacy-agent',
  async run({ prisma, logger }) {
    logger.info('🔎 Seeding the Conditional Topics candidacy-check agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    // Fill the binding only where nobody has chosen one. An operator who picked a model in the
    // admin UI keeps it; a database seeded before this agent had a model gets the measured default.
    const existing = await prisma.aiAgent.findUnique({
      where: { slug: SLUG },
      select: { model: true, provider: true },
    });
    const bindingIsUnset = Boolean(existing && !existing.model && !existing.provider);

    await prisma.aiAgent.upsert({
      where: { slug: SLUG },
      update: {
        isSystem: false,
        ...(bindingIsUnset ? { model: CANDIDACY_MODEL, provider: CANDIDACY_PROVIDER } : {}),
      },
      create: {
        name: 'Conditional Topics Candidacy Check',
        slug: SLUG,
        description:
          'Cheap triage read that flags a freshly-uploaded questionnaire as a Conditional Topics ' +
          'candidate when its own text describes conditional routing.',
        systemInstructions: SYSTEM_INSTRUCTIONS,
        // Explicit, and measured — see the docblock. Clear both to fall back to the routing tier.
        model: CANDIDACY_MODEL,
        provider: CANDIDACY_PROVIDER,
        // Near-deterministic triage read — same band as the extraction verifier.
        temperature: 0.2,
        // Verdict + a handful of signals stays small.
        maxTokens: 1024,
        monthlyBudgetUsd: 15,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        isActive: true,
        isSystem: false,
        createdBy: admin.id,
      },
    });

    logger.info(`✅ Seeded ${SLUG} agent`);
  },
};

export default unit;
