/**
 * Deterministic executor for the Structure Edit Agent.
 *
 * `resolveOps` applies a validated `EditOp[]` to a clone of the current structure, then diffs the
 * result against the original to produce a flat `ResolvedChange[]`. That single list drives both the
 * preview (render `label` + `before`→`after`) and the apply transaction (write `value` per
 * `entityId`/`field`). Apply re-runs this against live DB state, so the preview is advisory and a
 * concurrent edit can't be silently clobbered.
 *
 * Pure — no IO. The only failure mode is a structurally-impossible op (unknown key/ordinal, a
 * non-permutation reorder), surfaced as {@link EditOpError} for the route to map to 422.
 */

import type {
  EditOp,
  QuestionSelector,
  SectionSelector,
  TextTransform,
} from '@/lib/app/questionnaire/edit-agent/edit-ops';
import type {
  EditableQuestion,
  EditableSection,
  EditableStructure,
  ResolvedChange,
} from '@/lib/app/questionnaire/edit-agent/types';

/** A structurally-impossible op (the route maps this to HTTP 422). */
export class EditOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditOpError';
  }
}

const LABEL_CAP = 60;

function truncate(text: string): string {
  return text.length > LABEL_CAP ? `${text.slice(0, LABEL_CAP - 1)}…` : text;
}

function applyTransform(text: string, transform: TextTransform): string {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'trim':
      return text.trim();
    case 'titlecase':
      return text.replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/** Leading "1." / "2)" / "3:" style numeric prefix on a section title. */
const NUMBER_PREFIX = /^\s*\d+\s*[.):-]?\s+/;

function stripNumberPrefix(title: string): string {
  return title.replace(NUMBER_PREFIX, '');
}

function cloneStructure(structure: EditableStructure): EditableStructure {
  return {
    versionId: structure.versionId,
    sections: structure.sections
      .map((s) => ({ ...s, questions: s.questions.map((q) => ({ ...q })) }))
      .sort((a, b) => a.ordinal - b.ordinal),
  };
}

/** Reassign 0-based ordinals from array position so a later op sees a consistent view. */
function reindex(structure: EditableStructure): void {
  structure.sections.forEach((section, si) => {
    section.ordinal = si;
    section.questions.forEach((q, qi) => {
      q.ordinal = qi;
    });
  });
}

function matchQuestions(
  structure: EditableStructure,
  selector: QuestionSelector
): EditableQuestion[] {
  const all = structure.sections.flatMap((s) => s.questions);
  switch (selector.scope) {
    case 'all':
      return all;
    case 'section': {
      const section = structure.sections.find((s) => s.ordinal === selector.sectionOrdinal);
      return section ? section.questions : [];
    }
    case 'type':
      return all.filter((q) => q.type === selector.questionType);
    case 'keys': {
      const wanted = new Set(selector.keys);
      return all.filter((q) => wanted.has(q.key));
    }
  }
}

function matchSections(structure: EditableStructure, selector: SectionSelector): EditableSection[] {
  switch (selector.scope) {
    case 'all':
      return structure.sections;
    case 'ordinals': {
      const wanted = new Set(selector.ordinals);
      return structure.sections.filter((s) => wanted.has(s.ordinal));
    }
  }
}

function applyOp(structure: EditableStructure, op: EditOp): void {
  switch (op.op) {
    case 'set_required':
      for (const q of matchQuestions(structure, op.target)) q.required = op.value;
      break;
    case 'set_weight':
      for (const q of matchQuestions(structure, op.target)) q.weight = op.value;
      break;
    case 'transform_prompt':
      for (const q of matchQuestions(structure, op.target)) {
        q.prompt = applyTransform(q.prompt, op.transform);
      }
      break;
    case 'rename_prompt': {
      const q = structure.sections.flatMap((s) => s.questions).find((x) => x.key === op.key);
      if (!q) throw new EditOpError(`No question with key "${op.key}"`);
      q.prompt = op.value;
      break;
    }
    case 'transform_title':
      for (const s of matchSections(structure, op.target)) {
        s.title = applyTransform(s.title, op.transform);
      }
      break;
    case 'set_section_title': {
      const s = structure.sections.find((x) => x.ordinal === op.sectionOrdinal);
      if (!s) throw new EditOpError(`No section at position ${op.sectionOrdinal + 1}`);
      s.title = op.value;
      break;
    }
    case 'renumber_sections':
      structure.sections.forEach((s, i) => {
        const base = stripNumberPrefix(s.title);
        s.title = op.style === 'prefix-number' ? `${i + 1}. ${base}` : base;
      });
      break;
    case 'reorder_sections': {
      const current = structure.sections.map((s) => s.ordinal).sort((a, b) => a - b);
      const requested = [...op.order].sort((a, b) => a - b);
      if (current.length !== requested.length || current.some((ord, i) => ord !== requested[i])) {
        throw new EditOpError(
          'reorder_sections order must be a permutation of the section ordinals'
        );
      }
      structure.sections.sort((a, b) => op.order.indexOf(a.ordinal) - op.order.indexOf(b.ordinal));
      break;
    }
    case 'move_question': {
      let moved: EditableQuestion | undefined;
      for (const s of structure.sections) {
        const idx = s.questions.findIndex((q) => q.key === op.key);
        if (idx >= 0) {
          moved = s.questions.splice(idx, 1)[0];
          break;
        }
      }
      if (!moved) throw new EditOpError(`No question with key "${op.key}"`);
      const dest = structure.sections.find((s) => s.ordinal === op.toSectionOrdinal);
      if (!dest) throw new EditOpError(`No section at position ${op.toSectionOrdinal + 1}`);
      const at =
        op.toIndex === undefined
          ? dest.questions.length
          : Math.min(op.toIndex, dest.questions.length);
      dest.questions.splice(at, 0, moved);
      break;
    }
  }
  reindex(structure);
}

/** Build a `{ questionId → owning section }` map for the section-move diff. */
function sectionByQuestionId(structure: EditableStructure): Map<string, EditableSection> {
  const map = new Map<string, EditableSection>();
  for (const s of structure.sections) for (const q of s.questions) map.set(q.id, s);
  return map;
}

function diffStructures(before: EditableStructure, after: EditableStructure): ResolvedChange[] {
  const changes: ResolvedChange[] = [];

  const beforeSections = new Map(before.sections.map((s) => [s.id, s]));
  for (const s of after.sections) {
    const prev = beforeSections.get(s.id);
    if (!prev) continue;
    if (prev.title !== s.title) {
      changes.push({
        entity: 'section',
        entityId: s.id,
        label: truncate(prev.title),
        field: 'section.title',
        before: prev.title,
        after: s.title,
        value: s.title,
      });
    }
    if (prev.ordinal !== s.ordinal) {
      changes.push({
        entity: 'section',
        entityId: s.id,
        label: truncate(s.title),
        field: 'section.ordinal',
        before: String(prev.ordinal + 1),
        after: String(s.ordinal + 1),
        value: s.ordinal,
      });
    }
  }

  const beforeQuestions = new Map(
    before.sections.flatMap((s) => s.questions).map((q) => [q.id, q])
  );
  const beforeOwner = sectionByQuestionId(before);
  for (const s of after.sections) {
    for (const q of s.questions) {
      const prev = beforeQuestions.get(q.id);
      if (!prev) continue;
      const label = truncate(q.prompt);
      if (prev.prompt !== q.prompt) {
        changes.push({
          entity: 'question',
          entityId: q.id,
          key: q.key,
          label: truncate(prev.prompt),
          field: 'question.prompt',
          before: prev.prompt,
          after: q.prompt,
          value: q.prompt,
        });
      }
      if (prev.required !== q.required) {
        changes.push({
          entity: 'question',
          entityId: q.id,
          key: q.key,
          label,
          field: 'question.required',
          before: prev.required ? 'required' : 'optional',
          after: q.required ? 'required' : 'optional',
          value: q.required,
        });
      }
      if (prev.weight !== q.weight) {
        changes.push({
          entity: 'question',
          entityId: q.id,
          key: q.key,
          label,
          field: 'question.weight',
          before: prev.weight.toFixed(2),
          after: q.weight.toFixed(2),
          value: q.weight,
        });
      }
      const prevSection = beforeOwner.get(q.id);
      if (prevSection && prevSection.id !== s.id) {
        changes.push({
          entity: 'question',
          entityId: q.id,
          key: q.key,
          label,
          field: 'question.section',
          before: truncate(prevSection.title),
          after: truncate(s.title),
          value: q.ordinal,
          toSectionId: s.id,
        });
      } else if (prev.ordinal !== q.ordinal) {
        changes.push({
          entity: 'question',
          entityId: q.id,
          key: q.key,
          label,
          field: 'question.ordinal',
          before: String(prev.ordinal + 1),
          after: String(q.ordinal + 1),
          value: q.ordinal,
        });
      }
    }
  }

  return changes;
}

/**
 * Apply `ops` to `structure` and return the desired end-state plus the concrete change list.
 * Throws {@link EditOpError} on a structurally-impossible op.
 */
export function resolveOps(
  structure: EditableStructure,
  ops: EditOp[]
): { desired: EditableStructure; changes: ResolvedChange[] } {
  const desired = cloneStructure(structure);
  reindex(desired);
  const baseline = cloneStructure(desired); // post-reindex original, for an honest diff
  for (const op of ops) applyOp(desired, op);
  return { desired, changes: diffStructures(baseline, desired) };
}
