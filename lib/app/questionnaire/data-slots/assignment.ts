/**
 * Pure, deterministic merge for the assign-orphans flow (Data Slots feature).
 *
 * The `app_assign_data_slots` capability only *decides* where each newly-added (orphaned) question
 * should land — it never rewrites the existing slots. This function applies those decisions
 * deterministically: existing slots are preserved verbatim and only gain question keys; `new`
 * placements become new slots (deduped by name so two questions can share one); and any orphan the
 * model failed to place gets a safety-net slot derived from its prompt — so an orphan is never left
 * behind. The result is the full save-shape set the route hands to `replaceDataSlots`.
 *
 * No Prisma / Next — the route supplies the existing slots, the placements, and the orphan prompts.
 */

import type { DataSlotPlacement } from '@/lib/app/questionnaire/data-slots/schemas';

/** An existing slot, as the merge needs it (the live set, minus weight/ordinal). */
export interface AssignableSlot {
  key: string;
  name: string;
  description: string;
  theme: string;
  questionKeys: string[];
}

/** A new (orphaned) question to place, with the context the safety-net slot needs. */
export interface OrphanQuestion {
  key: string;
  prompt: string;
  sectionTitle?: string;
}

/** The save-shape slot `replaceDataSlots` consumes. */
export interface MergedSlot {
  name: string;
  description: string;
  theme: string;
  questionKeys: string[];
}

/**
 * Normalise a slot name for dedup/matching — case-, whitespace-, AND underscore-insensitive, so a
 * model that returns a snake_case name (`current_morale`) still folds into a human existing slot
 * ("Current morale") instead of creating a near-duplicate.
 */
function normName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ');
}

/**
 * Make a slot name human, to match the existing slots ("Work morale", "Time to value"). The assign
 * model sometimes echoes the question-key style and returns a snake_case name; convert underscores
 * to spaces and sentence-case the result. Names that are already human pass through (bar a leading
 * capital). Defensive: this is the deterministic backstop to the prompt's "no snake_case" rule.
 */
function humanizeName(name: string): string {
  const spaced = name.includes('_') && !name.includes(' ') ? name.replace(/_+/g, ' ') : name;
  const trimmed = spaced.trim();
  if (trimmed.length === 0) return 'Additional detail';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** A 1–4 word, ≤60-char human name derived from a question prompt (safety-net slots). */
function nameFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const name = words.join(' ').slice(0, 60).trim();
  return name.length > 0 ? humanizeName(name) : 'Additional detail';
}

/**
 * Apply the assigner's placements to the existing slot set. Returns the full set to persist:
 * existing slots (in order, with newly-placed keys unioned in) followed by any new slots. Every
 * orphan in `orphans` ends up somewhere — placed by the model, or in a derived fallback slot.
 */
export function mergeAssignments(
  existing: AssignableSlot[],
  placements: DataSlotPlacement[],
  orphans: OrphanQuestion[]
): MergedSlot[] {
  const orphanByKey = new Map(orphans.map((o) => [o.key, o]));

  // Working copies of existing slots (preserved verbatim; only questionKeys grow).
  type WorkingSlot = { name: string; description: string; theme: string; _keys: Set<string> };
  const existingByKey = new Map<string, WorkingSlot>();
  const existingByName = new Map<string, string>(); // normName → slotKey, to fold name-matched 'new'
  const ordered: WorkingSlot[] = [];
  for (const s of existing) {
    const entry = {
      name: s.name,
      description: s.description,
      theme: s.theme,
      _keys: new Set(s.questionKeys),
    };
    existingByKey.set(s.key, entry);
    existingByName.set(normName(s.name), s.key);
    ordered.push(entry);
  }

  // New slots accumulated by normalised name so multiple orphans can share one.
  const newByName = new Map<
    string,
    { name: string; description: string; theme: string; _keys: Set<string> }
  >();
  const placed = new Set<string>();

  for (const p of placements) {
    if (!orphanByKey.has(p.questionKey) || placed.has(p.questionKey)) continue; // ignore unknown/dupe

    if (p.target.kind === 'existing') {
      const entry = existingByKey.get(p.target.slotKey);
      if (entry) {
        entry._keys.add(p.questionKey);
        placed.add(p.questionKey);
        continue;
      }
      // Unknown slotKey → fall through to the fallback path below (leave unplaced).
      continue;
    }

    // 'new' — but if the name matches an existing slot, fold into that slot instead of duplicating.
    const matchedExistingKey = existingByName.get(normName(p.target.name));
    if (matchedExistingKey) {
      existingByKey.get(matchedExistingKey)!._keys.add(p.questionKey);
      placed.add(p.questionKey);
      continue;
    }
    const nameKey = normName(p.target.name);
    const slot = newByName.get(nameKey) ?? {
      name: humanizeName(p.target.name),
      description: p.target.description,
      theme: p.target.theme,
      _keys: new Set<string>(),
    };
    slot._keys.add(p.questionKey);
    newByName.set(nameKey, slot);
    placed.add(p.questionKey);
  }

  // Safety net: any orphan the model didn't place gets a slot derived from its prompt.
  const fallback: { name: string; description: string; theme: string; _keys: Set<string> }[] = [];
  for (const orphan of orphans) {
    if (placed.has(orphan.key)) continue;
    fallback.push({
      name: nameFromPrompt(orphan.prompt),
      description: orphan.prompt,
      theme: orphan.sectionTitle?.trim() || 'Additional',
      _keys: new Set([orphan.key]),
    });
  }

  return [...ordered, ...newByName.values(), ...fallback].map((s) => ({
    name: s.name,
    description: s.description,
    theme: s.theme,
    questionKeys: [...s._keys],
  }));
}
