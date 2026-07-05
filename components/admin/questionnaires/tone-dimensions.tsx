'use client';

/**
 * Shared interviewer tone-dimension UI (F-tone / F-persona).
 *
 * `TONE_DIMENSION_META` (display copy for the nine sliders) and `ToneDimensionRow` (one enable
 * toggle + 1–5 slider) are used both by the version-level tone panel in `config-editor.tsx` and by
 * each persona card in `persona-library-panel.tsx`. Extracted here so a persona's tone preset is
 * edited with the exact same control as the version tone — one definition, no drift.
 */

import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  TONE_LEVEL_MAX,
  TONE_LEVEL_MIN,
  type ToneDimension,
  type ToneDimensionKey,
} from '@/lib/app/questionnaire/types';

/**
 * Tone dimensions (F-tone) — display metadata for the nine sliders. `left`/`right` label the 1 and
 * 5 poles; `help` is the FieldHelp copy. Order matches the on-screen order (mirrors the prompt).
 */
export const TONE_DIMENSION_META: {
  key: ToneDimensionKey;
  label: string;
  left: string;
  right: string;
  help: string;
}[] = [
  {
    key: 'empathy',
    label: 'Empathy',
    left: 'Dispassionate',
    right: 'Highly empathetic',
    help: 'How much the interviewer acknowledges and validates feelings in an answer. Low keeps a matter-of-fact, clinical manner; high names and gently validates emotion before moving on. The middle is balanced.',
  },
  {
    key: 'mirroring',
    label: 'Mirroring',
    left: 'Never',
    right: 'Always',
    help: 'How often the interviewer reflects what the respondent said back — reframed in its own words — before the next question. Higher means it confirms understanding more often, which can feel attentive but slows the pace.',
  },
  {
    key: 'formality',
    label: 'Formality',
    left: 'Casual',
    right: 'Formal',
    help: 'The register. Low is relaxed and conversational (contractions, friendly phrasing); high is polished and businesslike. The middle leaves it unconstrained.',
  },
  {
    key: 'mimicry',
    label: 'Mimicry',
    left: 'Own voice',
    right: 'Mirror them',
    help: "How much the interviewer adopts the respondent's own vocabulary, register, and speech patterns. Higher makes it sound more like the person it's talking to. When enabled, this replaces the default gentle 'match their tone' behaviour.",
  },
  {
    key: 'verbosity',
    label: 'Verbosity',
    left: 'Terse',
    right: 'Expansive',
    help: 'How much the interviewer says per turn. Low is the fewest words that ask clearly; high adds context and elaboration. The opening questions are always kept short regardless, so they stay effortless.',
  },
  {
    key: 'warmth',
    label: 'Warmth & encouragement',
    left: 'Neutral',
    right: 'Very encouraging',
    help: 'How much affirmation and reassurance the interviewer offers. Higher gives generous, genuine encouragement as the conversation goes; this is about positive reinforcement, distinct from empathy (acknowledging difficulty).',
  },
  {
    key: 'curiosity',
    label: 'Curiosity',
    left: 'Take at face value',
    right: 'Probe deeply',
    help: 'How hard the interviewer digs with follow-ups before moving on. Higher means it consistently probes for detail, examples, and the “why”. Note the move-on cap still parks a question after the configured number of attempts.',
  },
  {
    key: 'readingComplexity',
    label: 'Reading complexity',
    left: 'Plain',
    right: 'Sophisticated',
    help: 'The language level. Low uses plain, everyday words and short sentences; high uses richer vocabulary and more developed sentences. Audience expertise (set on the Structure tab) also influences this.',
  },
  {
    key: 'humour',
    label: 'Humour',
    left: 'Earnest',
    right: 'Playful',
    help: 'How much light playfulness the interviewer allows. Low stays strictly earnest; high is good-humoured where it fits (never at the respondent’s expense). Use sparingly on sensitive questionnaires.',
  },
];

/**
 * One tone dimension row: an enable toggle + (when on) a 1–5 slider with pole labels. Shared by the
 * version tone panel and the per-persona tone preset editor.
 */
export function ToneDimensionRow({
  meta,
  value,
  busy,
  onToggle,
  onLevel,
}: {
  meta: (typeof TONE_DIMENSION_META)[number];
  value: ToneDimension;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onLevel: (level: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Switch checked={value.enabled} onCheckedChange={onToggle} disabled={busy} />
        <Label className="text-sm font-medium">
          {meta.label} <FieldHelp title={meta.label}>{meta.help}</FieldHelp>
        </Label>
      </div>
      {value.enabled && (
        <div className="border-border/60 ml-1 space-y-1.5 border-l pl-4">
          <Slider
            value={[value.level]}
            min={TONE_LEVEL_MIN}
            max={TONE_LEVEL_MAX}
            step={1}
            onValueChange={([v]) => onLevel(v)}
            disabled={busy}
            className="max-w-xs"
            aria-label={`${meta.label} level`}
          />
          <div className="text-muted-foreground flex max-w-xs justify-between text-xs">
            <span>{meta.left}</span>
            <span className="text-foreground font-medium">{value.level}/5</span>
            <span>{meta.right}</span>
          </div>
        </div>
      )}
    </div>
  );
}
