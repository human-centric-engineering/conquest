/**
 * Plain-English sentence for one {@link PolicyProposedEdit} (F18.8).
 *
 * Shared by the finding review card and the Questionnaire Pack, so the console and the export can
 * never disagree about what an op does.
 *
 * **Imports nothing but `types.ts`, deliberately.** It is pulled into a client bundle by the review
 * card and into the pack builder on the server; a stray import of `settings-registry.ts` or
 * anything under `chat/**` would drag a graph into the browser for the sake of one switch.
 */

import type { PolicyProposedEdit } from '@/lib/app/questionnaire/policy-evaluation/types';

const KIND_WORDS: Record<string, string> = {
  always: 'always do',
  never: 'never do',
  if_asked: 'say if asked',
};

const APPROACH_WORDS: Record<string, string> = {
  funnel: 'Funnel (open, then targeted)',
  open: 'Open throughout',
  targeted: 'Targeted',
};

const PACE_WORDS: Record<string, string> = {
  gradual: 'Stay open longer',
  balanced: 'Balanced',
  brisk: 'Narrow quickly',
};

const STOP_WORDS: Record<number, string> = {
  0: 'Free',
  0.25: 'Loose',
  0.5: 'Balanced',
  0.75: 'Close',
  1: 'Must ask',
};

/** A short sentence naming what applying this edit would do. */
export function describePolicyProposedEdit(edit: PolicyProposedEdit): string {
  switch (edit.op) {
    case 'edit_house_rule':
      return `Reword this rule (${KIND_WORDS[edit.kind] ?? edit.kind})`;
    case 'set_house_rule_enabled':
      return edit.enabled ? 'Switch this rule on' : 'Switch this rule off';
    case 'delete_house_rule':
      return 'Remove this rule';
    case 'add_house_rule':
      return `Add a new rule (${KIND_WORDS[edit.kind] ?? edit.kind})`;
    case 'set_approach':
      return `Change the questioning approach to ${APPROACH_WORDS[edit.approach] ?? edit.approach}`;
    case 'set_pace':
      return `Change the funnel pace to ${PACE_WORDS[edit.pace] ?? edit.pace}`;
    case 'set_opening_mode':
      return edit.openingMode === 'examples'
        ? 'Use your example openings'
        : 'Let the interviewer choose its own opening';
    case 'set_tactics': {
      const parts = [
        edit.probeDepth !== undefined &&
          `${edit.probeDepth ? 'turn on' : 'turn off'} probing shallow answers`,
        edit.reflect !== undefined &&
          `${edit.reflect ? 'turn on' : 'turn off'} reflecting answers back`,
        edit.batchRelated !== undefined &&
          `${edit.batchRelated ? 'turn on' : 'turn off'} inviting related gaps together`,
      ].filter((p): p is string => typeof p === 'string');
      return parts.length > 0 ? `Change tactics: ${parts.join(', ')}` : 'Change the tactics';
    }
    case 'set_fidelity_enabled':
      return edit.enabled
        ? 'Switch on asking questions as written'
        : 'Switch off asking questions as written';
    case 'set_default_fidelity':
      return `Start new questions at ${STOP_WORDS[edit.defaultFidelity] ?? edit.defaultFidelity}`;
    case 'set_question_fidelity':
      return `Set this question to ${STOP_WORDS[edit.fidelity] ?? edit.fidelity}`;
    case 'set_tone_dimension':
      return edit.enabled
        ? `Set the ${edit.dimension} tone dial${edit.level !== undefined ? ` to level ${edit.level}` : ''}`
        : `Turn off the ${edit.dimension} tone dial`;
  }
}
