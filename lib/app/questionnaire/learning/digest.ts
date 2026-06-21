/**
 * Learning Mode — the round peer-theme digest.
 *
 * Builds and reads `AppRoundLearningDigest`: a cached, generalised, anonymised theme per slot,
 * synthesised from prior respondents' answers within ONE round + version. The live interviewer reads
 * it cheaply each turn (never re-aggregating); it's rebuilt when a session completes.
 *
 * **Privacy by construction.** Only completed, non-preview sessions count, and high-sensitivity
 * sessions are excluded wholesale. A k-anonymity threshold (`learningConfig.minRespondents`) gates
 * BOTH the round (no digest at all below it) and each slot (a slot is only generalised once enough
 * distinct respondents have filled it). The LLM is instructed to produce generalised themes only —
 * no names, no verbatim quotes, no individual attribution. The current respondent is excluded
 * structurally: their session is still `active` (not `completed`), so it never enters the corpus.
 *
 * **Bias is intentional.** Surfacing peers' themes to a later respondent influences them — the admin
 * opts in per round and the UI warns; this module just builds the data faithfully.
 *
 * Sibling to `report/` (server lib; Prisma is fine here — this is not a `capabilities/` module).
 */

import { z } from 'zod';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import {
  runStructuredCompletion,
  tryParseJson,
} from '@/lib/orchestration/evaluations/parse-structured';
import { joinSections, section } from '@/lib/app/questionnaire/prompt/format';
import { QUESTIONNAIRE_COMPOSER_AGENT_SLUG } from '@/lib/app/questionnaire/constants';
import { resolveLearningConfig } from '@/lib/app/questionnaire/rounds/types';

const DIGEST_MAX_TOKENS = 4_000;
const DIGEST_TIMEOUT_MS = 60_000;
/** Per-slot sample cap fed to the model (keeps the prompt bounded). */
const MAX_SAMPLES_PER_SLOT = 12;
/** Per-sample char cap. */
const SAMPLE_CHARS = 280;
/** Cap on slots generalised in one pass (large surveys). */
const MAX_SLOTS = 40;

export type PeerSlotKind = 'data_slot' | 'question';

/** One generalised peer theme, as read by the live interviewer. */
export interface PeerInsight {
  slotKind: PeerSlotKind;
  slotKey: string;
  insight: string;
  divergence: number | null;
}

/** Outcome of a refresh — `built:false` carries why (below threshold, no slots, LLM failure…). */
export interface RefreshResult {
  built: boolean;
  reason?: string;
  slotCount?: number;
}

interface SlotSamples {
  kind: PeerSlotKind;
  key: string;
  label: string;
  /** One entry per distinct respondent who filled this slot. */
  samples: string[];
}

/** The model's per-slot reply contract. */
const themeSchema = z.object({
  themes: z
    .array(
      z.object({
        key: z.string(),
        insight: z.string(),
        divergence: z.number().min(0).max(1).nullish(),
      })
    )
    .default([]),
});

/** Compact a stored answer value to a short sample string. */
function valueToSample(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    // Non-serialisable (e.g. circular) → skip rather than emit '[object Object]'.
    return '';
  }
}

/** Delete any existing digest for this round+version (used when the corpus drops below threshold). */
async function clearDigest(roundId: string, versionId: string): Promise<void> {
  await prisma.appRoundLearningDigest.deleteMany({ where: { roundId, versionId } });
}

/**
 * Generalise the qualifying slots into anonymised themes via one structured LLM call through the
 * composer agent. Returns `null` on any failure (no agent, no provider, bad JSON) so the caller
 * leaves the existing digest untouched rather than wiping it on a transient error.
 */
async function generaliseThemes(
  slots: SlotSamples[]
): Promise<Array<{ key: string; insight: string; divergence: number | null }> | null> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_COMPOSER_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    logger.warn('learning digest: composer agent not configured; skipping generalisation');
    return null;
  }

  let providerSlug: string;
  let model: string;
  try {
    const resolved = await resolveAgentProviderAndModel(agent, 'reasoning');
    providerSlug = resolved.providerSlug;
    model = resolved.model;
  } catch (err) {
    logger.warn('learning digest: no provider resolved', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const slotBlocks = slots
    .map((s) => {
      const samples = s.samples
        .slice(0, MAX_SAMPLES_PER_SLOT)
        .map((v, i) => `  ${i + 1}. ${v.slice(0, SAMPLE_CHARS)}`)
        .join('\n');
      return `[key:${s.key}] ${s.label} (${s.samples.length} respondents):\n${samples}`;
    })
    .join('\n\n');

  const system = joinSections(
    section(
      'role',
      'You distil what a group of survey respondents said on each topic into ONE short, generalised ' +
        'theme an interviewer could gently raise with the NEXT respondent — like a consultant who has ' +
        'spoken to several people and notices a pattern.'
    ),
    section(
      'rules',
      joinSections(
        'Write ONE theme per topic (key). 1–2 sentences, generalised across respondents — e.g. ' +
          '"Several mentioned workload pressure around month-end."',
        'NEVER name or identify anyone, never quote anyone verbatim, never attribute a view to a ' +
          'single individual. Speak only in aggregate ("some", "several", "a few", "most").',
        'Also give a `divergence` score 0–1: 0 = strong consensus, 1 = highly split/varied views. ' +
          'Use it to flag topics worth probing more deeply.',
        'If a topic has no meaningful shared signal, omit it rather than inventing one.'
      )
    ),
    section('topics', slotBlocks),
    section(
      'output_format',
      'Reply with ONLY JSON: {"themes":[{"key":string,"insight":string,"divergence":number}]}. ' +
        'No prose, no markdown fences.'
    )
  );

  try {
    const provider = await getProvider(providerSlug);
    const completion = await runStructuredCompletion<z.infer<typeof themeSchema>>({
      provider,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Produce the generalised themes now as JSON.' },
      ],
      maxTokens: DIGEST_MAX_TOKENS,
      timeoutMs: DIGEST_TIMEOUT_MS,
      parse: (raw) =>
        tryParseJson(raw, (parsed) => {
          const r = themeSchema.safeParse(parsed);
          return r.success ? r.data : null;
        }),
      retryUserMessage:
        'That was not valid JSON. Reply with ONLY {"themes":[{"key":string,"insight":string,"divergence":number}]}.',
      onFinalFailure: () =>
        new Error('Learning digest response was not valid JSON after one retry'),
    });

    void logCost({
      agentId: agent.id,
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: 'app_learning_digest', slots: slots.length },
    }).catch(() => {});

    const valid = new Set(slots.map((s) => s.key));
    return completion.value.themes
      .filter((t) => valid.has(t.key) && t.insight.trim().length > 0)
      .map((t) => ({
        key: t.key,
        insight: t.insight.trim(),
        divergence: typeof t.divergence === 'number' ? t.divergence : null,
      }));
  } catch (err) {
    logger.warn('learning digest: generalisation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Rebuild the round's peer-theme digest for one version. Best-effort + fail-soft (never throws):
 * called from the submit path after a session completes. Clears the digest when the corpus falls
 * below the k-anonymity threshold; leaves it untouched on a transient LLM failure.
 */
export async function refreshRoundLearningDigest(
  roundId: string,
  versionId: string
): Promise<RefreshResult> {
  try {
    const round = await prisma.appQuestionnaireRound.findUnique({
      where: { id: roundId },
      select: { learningEnabled: true, learningConfig: true },
    });
    if (!round || !round.learningEnabled) return { built: false, reason: 'learning_disabled' };
    const { minRespondents } = resolveLearningConfig(round.learningConfig);

    // Eligible corpus: completed, non-preview, NOT high-sensitivity sessions on this version.
    const sessions = await prisma.appQuestionnaireSession.findMany({
      where: {
        roundId,
        versionId,
        status: 'completed',
        isPreview: false,
        NOT: { sensitivityLevel: 'high' },
      },
      select: { id: true },
    });
    if (sessions.length < minRespondents) {
      await clearDigest(roundId, versionId);
      return { built: false, reason: 'below_threshold' };
    }
    const sessionIds = sessions.map((s) => s.id);

    // Prefer data slots (their paraphrases generalise best); else fall back to question answers.
    const dataSlots = await prisma.appDataSlot.findMany({
      where: { versionId },
      select: { id: true, key: true, name: true },
    });

    const slots: SlotSamples[] = [];
    const respondentCountByKey = new Map<string, number>();

    if (dataSlots.length > 0) {
      const byId = new Map(dataSlots.map((d) => [d.id, d]));
      const fills = await prisma.appDataSlotFill.findMany({
        where: { sessionId: { in: sessionIds }, dataSlotId: { in: dataSlots.map((d) => d.id) } },
        select: { dataSlotId: true, paraphrase: true, value: true },
      });
      const samplesById = new Map<string, string[]>();
      for (const f of fills) {
        const sample = (f.paraphrase ?? '').trim() || valueToSample(f.value);
        if (!sample) continue;
        const list = samplesById.get(f.dataSlotId) ?? [];
        list.push(sample);
        samplesById.set(f.dataSlotId, list);
      }
      for (const [id, samples] of samplesById) {
        const d = byId.get(id);
        if (!d || samples.length < minRespondents) continue;
        slots.push({ kind: 'data_slot', key: d.key, label: d.name, samples });
        respondentCountByKey.set(`data_slot:${d.key}`, samples.length);
      }
    } else {
      const answers = await prisma.appAnswerSlot.findMany({
        where: { sessionId: { in: sessionIds } },
        select: { value: true, questionSlot: { select: { key: true, prompt: true } } },
      });
      const samplesByKey = new Map<string, { label: string; samples: string[] }>();
      for (const a of answers) {
        const sample = valueToSample(a.value).trim();
        if (!sample) continue;
        const entry = samplesByKey.get(a.questionSlot.key) ?? {
          label: a.questionSlot.prompt,
          samples: [],
        };
        entry.samples.push(sample);
        samplesByKey.set(a.questionSlot.key, entry);
      }
      for (const [key, { label, samples }] of samplesByKey) {
        if (samples.length < minRespondents) continue;
        slots.push({ kind: 'question', key, label, samples });
        respondentCountByKey.set(`question:${key}`, samples.length);
      }
    }

    if (slots.length === 0) {
      await clearDigest(roundId, versionId);
      return { built: false, reason: 'no_qualifying_slots' };
    }

    // Only the first MAX_SLOTS are sent to the model; key/count lookups below must use the SAME set
    // so a theme can never resolve a kind/count from a slot the model never saw.
    const sent = slots.slice(0, MAX_SLOTS);
    const themes = await generaliseThemes(sent);
    if (themes === null) return { built: false, reason: 'generalisation_failed' };
    if (themes.length === 0) {
      await clearDigest(roundId, versionId);
      return { built: false, reason: 'no_themes' };
    }

    const kindByKey = new Map(sent.map((s) => [s.key, s.kind]));
    const rows = themes
      .map((t) => {
        const kind = kindByKey.get(t.key);
        const respondentCount = kind ? respondentCountByKey.get(`${kind}:${t.key}`) : undefined;
        // Skip a theme whose key/count we can't resolve — never fabricate a count from the corpus size.
        if (!kind || respondentCount === undefined) return null;
        return {
          roundId,
          versionId,
          slotKind: kind,
          slotKey: t.key,
          insight: t.insight,
          respondentCount,
          divergence: t.divergence,
          sessionsCovered: sessions.length,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length === 0) {
      await clearDigest(roundId, versionId);
      return { built: false, reason: 'no_themes' };
    }

    // Replace wholesale so a shrunk corpus (e.g. after erasure) can't leave stale rows.
    await prisma.$transaction([
      prisma.appRoundLearningDigest.deleteMany({ where: { roundId, versionId } }),
      prisma.appRoundLearningDigest.createMany({ data: rows }),
    ]);

    return { built: true, slotCount: rows.length };
  } catch (err) {
    logger.error('learning digest: refresh failed', {
      roundId,
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { built: false, reason: 'error' };
  }
}

/**
 * The round's peer insights for a version, or `null` when the round is gone or its per-round
 * `learningEnabled` toggle is off (so the caller treats "off" and "no insights" identically). Rows
 * only exist when the k-anonymity threshold was met at last build, so the read needs no further gate.
 */
export async function loadRoundPeerDigest(
  roundId: string,
  versionId: string
): Promise<PeerInsight[] | null> {
  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: { learningEnabled: true },
  });
  if (!round || !round.learningEnabled) return null;
  const rows = await prisma.appRoundLearningDigest.findMany({
    where: { roundId, versionId },
    select: { slotKind: true, slotKey: true, insight: true, divergence: true },
  });
  return rows.map((r) => ({
    slotKind: r.slotKind === 'question' ? 'question' : 'data_slot',
    slotKey: r.slotKey,
    insight: r.insight,
    divergence: r.divergence,
  }));
}

/** One digest row enriched for the admin preview (carries audit fields the runtime read omits). */
export interface LearningDigestRow {
  versionId: string;
  slotKind: PeerSlotKind;
  slotKey: string;
  insight: string;
  respondentCount: number;
  divergence: number | null;
  refreshedAt: string;
}

/** A round's full digest (all versions), newest-first — the admin Learning panel's preview source. */
export async function listRoundLearningDigest(roundId: string): Promise<LearningDigestRow[]> {
  const rows = await prisma.appRoundLearningDigest.findMany({
    where: { roundId },
    orderBy: [{ refreshedAt: 'desc' }, { slotKey: 'asc' }],
    select: {
      versionId: true,
      slotKind: true,
      slotKey: true,
      insight: true,
      respondentCount: true,
      divergence: true,
      refreshedAt: true,
    },
  });
  return rows.map((r) => ({
    versionId: r.versionId,
    slotKind: r.slotKind === 'question' ? 'question' : 'data_slot',
    slotKey: r.slotKey,
    insight: r.insight,
    respondentCount: r.respondentCount,
    divergence: r.divergence,
    refreshedAt: r.refreshedAt.toISOString(),
  }));
}
