/**
 * Data-slot thematic material (report kind `cohort`, F14.7) — server-side only.
 *
 * The raw substance the narrative agent does its thematic analysis from: each data slot's captured
 * respondent positions (paraphrases). This deliberately stays OFF the client-facing `CohortDataset`
 * (which carries only aggregate counts) — individual paraphrases reach the agent's prompt server-side
 * and are synthesised into anonymised themes; they are never returned to the browser. k-anonymity:
 * a slot with fewer than the threshold of fills contributes no samples, and the caller skips this
 * entirely for a below-floor cohort.
 */

import { prisma } from '@/lib/db/client';
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';

/** Max paraphrases per slot fed to the agent (bounds the prompt; the agent synthesises, not quotes). */
const SAMPLES_PER_SLOT = 25;
/** Overall character cap on the material block. */
const MATERIAL_CHAR_CAP = 12_000;

function asSampleText(paraphrase: string | null, value: unknown): string | null {
  if (typeof paraphrase === 'string' && paraphrase.trim()) return paraphrase.trim().slice(0, 400);
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 400);
  if (value !== null && value !== undefined) {
    try {
      return JSON.stringify(value).slice(0, 400);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build the data-slot thematic material for a set of sessions — a text block of per-slot respondent
 * positions for the agent. Returns `''` when there are no slots/fills (or every slot is below the
 * k-anonymity floor). The caller must already have confirmed the cohort itself is above the floor.
 */
export async function buildDataSlotThemeMaterial(params: {
  versionId: string;
  sessionIds: string[];
}): Promise<string> {
  const { versionId, sessionIds } = params;
  if (sessionIds.length === 0) return '';

  const slots = await prisma.appDataSlot.findMany({
    where: { versionId },
    orderBy: { ordinal: 'asc' },
    select: { id: true, name: true, theme: true, description: true },
  });
  if (slots.length === 0) return '';

  const fills = await prisma.appDataSlotFill.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { dataSlotId: true, paraphrase: true, value: true },
  });
  if (fills.length === 0) return '';

  const bySlot = new Map<string, string[]>();
  for (const f of fills) {
    const text = asSampleText(f.paraphrase, f.value);
    if (!text) continue;
    const list = bySlot.get(f.dataSlotId) ?? [];
    list.push(text);
    bySlot.set(f.dataSlotId, list);
  }

  const blocks: string[] = [];
  for (const slot of slots) {
    const samples = bySlot.get(slot.id) ?? [];
    // k-anonymity: a slot answered by too few respondents contributes nothing.
    if (samples.length < K_ANONYMITY_THRESHOLD) continue;
    const capped = samples.slice(0, SAMPLES_PER_SLOT);
    blocks.push(
      `## ${slot.name} — ${slot.theme}\n(${slot.description})\n` +
        capped.map((s) => `- ${s}`).join('\n')
    );
  }

  if (blocks.length === 0) return '';
  return blocks.join('\n\n').slice(0, MATERIAL_CHAR_CAP);
}
