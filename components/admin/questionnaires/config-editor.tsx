'use client';

/**
 * ConfigEditor (F3.1) — the version run-time configuration section inside the
 * authoring editor. Every knob that controls how a session runs: question
 * selection, completion thresholds, budget/caps, voice/contradiction/anonymous
 * modes, and the session-start profile fields.
 *
 * Follows the surrounding editor's conventions (plain controlled state + the
 * `run` mutation runner threaded from `version-editor.tsx`, NOT react-hook-form,
 * which the goal/audience and section/question editors also avoid). A single
 * "Save configuration" sends the whole config; the server (`updateConfigSchema`)
 * is the source of truth and surfaces errors through the editor's shared banner.
 * `<FieldHelp>` ⓘ on every non-obvious field per the contextual-help directive.
 *
 * The config is hydrated from the same `VersionGraphView` the detail page already
 * fetched (no second fetch); `busy` disables the section while a mutation is in
 * flight, and the parent resyncs on refetch.
 */

import { useEffect, useState } from 'react';
import {
  Brain,
  ClipboardList,
  Gauge,
  ListChecks,
  Mail,
  MessageSquareText,
  Plus,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SaveButton } from '@/components/admin/questionnaires/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { cn } from '@/lib/utils';
import { CostEstimateCard } from '@/components/admin/questionnaires/cost-estimate-card';
import { AdaptiveEmbeddingStep } from '@/components/admin/questionnaires/adaptive-embedding-step';
import { API } from '@/lib/api/endpoints';
import {
  ACCESS_MODES,
  ACCESS_MODE_LABELS,
  ANSWER_FIT_MODES,
  ANSWER_SLOT_PANEL_SCOPES,
  CONTRADICTION_MODES,
  INVITEE_FIELD_LABELS,
  PRESENTATION_MODES,
  PROFILE_FIELD_TYPES,
  REASONING_PLACEMENTS,
  SELECTION_STRATEGIES,
  TONE_LEVEL_MAX,
  TONE_LEVEL_MIN,
  TONE_PERSONA_MAX_LENGTH,
  type AccessMode,
  type AnswerFitMode,
  type AnswerSlotPanelScope,
  type ContradictionMode,
  type InviteeFieldConfig,
  type PresentationMode,
  type ProfileFieldConfig,
  type ProfileFieldType,
  type ReasoningPlacement,
  type SelectionStrategy,
  type ToneDimension,
  type ToneDimensionKey,
  type ToneSettings,
} from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

const SELECTION_STRATEGY_LABELS: Record<SelectionStrategy, string> = {
  sequential: 'Sequential (in order)',
  random: 'Random (shuffled)',
  weighted: 'Weighted (by question weight)',
  adaptive: 'Adaptive (agent-chosen)',
};

const CONTRADICTION_MODE_LABELS: Record<ContradictionMode, string> = {
  off: 'Off',
  flag: 'Flag contradictions',
  probe: 'Probe (follow up in conversation)',
};

const ANSWER_FIT_MODE_LABELS: Record<AnswerFitMode, string> = {
  off: 'Off',
  fallback: 'Fallback (only when needed)',
  always: 'Always (every answered turn)',
};

const PROFILE_FIELD_TYPE_LABELS: Record<ProfileFieldType, string> = {
  text: 'Text',
  email: 'Email',
  number: 'Number',
  select: 'Select (choices)',
};

const ANSWER_SLOT_PANEL_SCOPE_LABELS: Record<AnswerSlotPanelScope, string> = {
  full_progress: 'Full progress (all questions)',
  answered_only: 'Answered only',
};

const PRESENTATION_MODE_LABELS: Record<PresentationMode, string> = {
  chat: 'Chat (conversation)',
  form: 'Form (sectioned)',
  both: 'Both (toggle)',
};

const REASONING_PLACEMENT_LABELS: Record<ReasoningPlacement, string> = {
  overlay: 'Live overlay (animates, then tucks away)',
  inline: 'Inline (quiet, under each turn)',
};

/** A profile-field row in local edit state — `options` carried as raw text. */
interface ProfileFieldRow {
  key: string;
  label: string;
  type: ProfileFieldType;
  required: boolean;
  /** Comma-separated options text; only meaningful for `select`. */
  optionsText: string;
}

function toRow(field: ProfileFieldConfig): ProfileFieldRow {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    optionsText: (field.options ?? []).join(', '),
  };
}

/** Parse a comma-separated options string into a distinct, non-empty list. */
function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const opt = raw.trim();
    if (opt && !seen.has(opt)) {
      seen.add(opt);
      out.push(opt);
    }
  }
  return out;
}

/**
 * Parse a "no cap" field (cost budget, per-session cap). Blank, non-positive, or
 * non-numeric all mean "no cap" → `null` — so typing `0` reads as no cap rather
 * than tripping the schema's `.positive()` rule. `integer` floors the result so a
 * mistyped decimal can't fail the schema's `.int()` rule.
 */
function capOrNull(value: string, integer: boolean): number | null {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n <= 0) return null;
  return integer ? Math.floor(n) : n;
}

/**
 * Parse a bounded number, clamped to `[min, max]`. A blank or non-numeric field
 * falls back to `fallback` (the current stored value) rather than silently
 * coercing to 0 — clearing a field to retype it must not weaken the stored config.
 */
function boundedNumber(
  value: string,
  min: number,
  max: number,
  fallback: number,
  integer = false
): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.floor(clamped) : clamped;
}

/**
 * A titled, icon-led group of related settings — the unit of organisation on the Settings tab.
 * Purely presentational: a card with a tinted icon chip, a one-line description, and the fields as
 * children. Grouping + ordering (most-used first) is what makes the long config scannable.
 */
function SettingsGroup({
  icon: Icon,
  accent,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  /** Tailwind classes tinting the icon chip — one hue per group, for at-a-glance scanning. */
  accent: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="bg-muted/30 flex-row items-start gap-3 space-y-0 border-b p-4">
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            accent
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="space-y-0.5">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          <CardDescription className="text-xs leading-relaxed">{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">{children}</CardContent>
    </Card>
  );
}

/**
 * Tone dimensions (F-tone) — display metadata for the nine sliders. `left`/`right` label the 1 and
 * 5 poles; `help` is the FieldHelp copy. Order matches the on-screen order (mirrors the prompt).
 */
const TONE_DIMENSION_META: {
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
 * One tone dimension row: an enable toggle + (when on) a 1–5 slider with pole labels. Kept local —
 * it's only used by the tone group below and shares its edit-state callbacks.
 */
function ToneDimensionRow({
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

export function ConfigEditor({
  questionnaireId,
  versionId,
  config,
  questionCount,
  adaptiveEnabled = true,
  run,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  config: ConfigView;
  /** Live question count on the version — folded into the estimate's reload key so it refreshes after question edits. */
  questionCount: number;
  /**
   * Whether the adaptive strategy sub-flag is on. When `false`, `adaptive` is
   * hidden from the picker (unless it's already the saved value, so the Select
   * still renders a label). Defaults to `true` for non-questionnaire mounts.
   */
  adaptiveEnabled?: boolean;
  run: RunMutation;
  busy: boolean;
}) {
  const [selectionStrategy, setSelectionStrategy] = useState<SelectionStrategy>(
    config.selectionStrategy
  );
  const [minQuestionsAnswered, setMinQuestionsAnswered] = useState(
    String(config.minQuestionsAnswered)
  );
  const [coverageThreshold, setCoverageThreshold] = useState(String(config.coverageThreshold));
  const [costBudgetUsd, setCostBudgetUsd] = useState(
    config.costBudgetUsd === null ? '' : String(config.costBudgetUsd)
  );
  const [maxQuestionsPerSession, setMaxQuestionsPerSession] = useState(
    config.maxQuestionsPerSession === null ? '' : String(config.maxQuestionsPerSession)
  );
  const [voiceEnabled, setVoiceEnabled] = useState(config.voiceEnabled);
  const [attachmentsEnabled, setAttachmentsEnabled] = useState(config.attachmentsEnabled);
  const [contradictionMode, setContradictionMode] = useState<ContradictionMode>(
    config.contradictionMode
  );
  const [contradictionWindowN, setContradictionWindowN] = useState(
    String(config.contradictionWindowN)
  );
  const [contradictionEveryNTurns, setContradictionEveryNTurns] = useState(
    String(config.contradictionEveryNTurns)
  );
  const [answerFitMode, setAnswerFitMode] = useState<AnswerFitMode>(config.answerFitMode);
  const [extractionPrefilter, setExtractionPrefilter] = useState(config.extractionPrefilter);
  const [anonymousMode, setAnonymousMode] = useState(config.anonymousMode);
  const [accessMode, setAccessMode] = useState<AccessMode>(config.accessMode);
  const [inviteeFields, setInviteeFields] = useState<InviteeFieldConfig[]>(config.inviteeFields);
  const [abuseThreshold, setAbuseThreshold] = useState(String(config.abuseThreshold));
  const [maxDataSlotAttempts, setMaxDataSlotAttempts] = useState(
    String(config.maxDataSlotAttempts)
  );
  const [sensitivityAwareness, setSensitivityAwareness] = useState(config.sensitivityAwareness);
  const [supportMessage, setSupportMessage] = useState(config.supportMessage);
  const [supportResourceUrl, setSupportResourceUrl] = useState(config.supportResourceUrl);
  const [answerSlotPanelScope, setAnswerSlotPanelScope] = useState<AnswerSlotPanelScope>(
    config.answerSlotPanelScope
  );
  const [presentationMode, setPresentationMode] = useState<PresentationMode>(
    config.presentationMode
  );
  const [reasoningStreamEnabled, setReasoningStreamEnabled] = useState(
    config.reasoningStreamEnabled
  );
  const [reasoningStreamPlacement, setReasoningStreamPlacement] = useState<ReasoningPlacement>(
    config.reasoningStreamPlacement
  );
  const [reasoningStreamPersist, setReasoningStreamPersist] = useState(
    config.reasoningStreamPersist
  );
  const [previewInspectorEnabled, setPreviewInspectorEnabled] = useState(
    config.previewInspectorEnabled
  );
  const [profileFields, setProfileFields] = useState<ProfileFieldRow[]>(
    config.profileFields.map(toRow)
  );
  // Interviewer tone & persona (F-tone): the whole block edited as one object. Helpers below patch
  // a single dimension / the persona immutably.
  const [tone, setTone] = useState<ToneSettings>(config.tone);

  // Resync from the server graph after each refetch (mirrors version-editor.tsx).
  useEffect(() => {
    setSelectionStrategy(config.selectionStrategy);
    setMinQuestionsAnswered(String(config.minQuestionsAnswered));
    setCoverageThreshold(String(config.coverageThreshold));
    setCostBudgetUsd(config.costBudgetUsd === null ? '' : String(config.costBudgetUsd));
    setMaxQuestionsPerSession(
      config.maxQuestionsPerSession === null ? '' : String(config.maxQuestionsPerSession)
    );
    setVoiceEnabled(config.voiceEnabled);
    setAttachmentsEnabled(config.attachmentsEnabled);
    setContradictionMode(config.contradictionMode);
    setContradictionWindowN(String(config.contradictionWindowN));
    setContradictionEveryNTurns(String(config.contradictionEveryNTurns));
    setAnswerFitMode(config.answerFitMode);
    setExtractionPrefilter(config.extractionPrefilter);
    setAnonymousMode(config.anonymousMode);
    setAccessMode(config.accessMode);
    setInviteeFields(config.inviteeFields);
    setAbuseThreshold(String(config.abuseThreshold));
    setMaxDataSlotAttempts(String(config.maxDataSlotAttempts));
    setSensitivityAwareness(config.sensitivityAwareness);
    setSupportMessage(config.supportMessage);
    setSupportResourceUrl(config.supportResourceUrl);
    setAnswerSlotPanelScope(config.answerSlotPanelScope);
    setPresentationMode(config.presentationMode);
    setReasoningStreamEnabled(config.reasoningStreamEnabled);
    setReasoningStreamPlacement(config.reasoningStreamPlacement);
    setReasoningStreamPersist(config.reasoningStreamPersist);
    setPreviewInspectorEnabled(config.previewInspectorEnabled);
    setProfileFields(config.profileFields.map(toRow));
    setTone(config.tone);
  }, [config]);

  const contradictionOff = contradictionMode === 'off';

  // Tone edit helpers — patch one dimension's toggle/level or the persona, immutably.
  const setToneDimension = (key: ToneDimensionKey, patch: Partial<ToneDimension>) =>
    setTone((t) => ({ ...t, [key]: { ...t[key], ...patch } }));
  const setTonePersona = (patch: Partial<ToneSettings['persona']>) =>
    setTone((t) => ({ ...t, persona: { ...t.persona, ...patch } }));

  const updateField = (index: number, patch: Partial<ProfileFieldRow>) =>
    setProfileFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  const addField = () =>
    setProfileFields((prev) => [
      ...prev,
      { key: '', label: '', type: 'text', required: false, optionsText: '' },
    ]);

  const removeField = (index: number) =>
    setProfileFields((prev) => prev.filter((_, i) => i !== index));

  const save = () =>
    run(() => [
      'PATCH',
      API.APP.QUESTIONNAIRES.versionConfig(questionnaireId, versionId),
      {
        selectionStrategy,
        // Floor to a non-negative integer; blank → 0 (no minimum).
        minQuestionsAnswered: boundedNumber(
          minQuestionsAnswered,
          0,
          Number.MAX_SAFE_INTEGER,
          0,
          true
        ),
        // Clamp to [0,1]; blank falls back to the stored value, never silently 0.
        coverageThreshold: boundedNumber(coverageThreshold, 0, 1, config.coverageThreshold),
        costBudgetUsd: capOrNull(costBudgetUsd, false),
        maxQuestionsPerSession: capOrNull(maxQuestionsPerSession, true),
        voiceEnabled,
        attachmentsEnabled,
        contradictionMode,
        // The schema forces N=0 when off and ≥1 otherwise — keep the body coherent.
        contradictionWindowN: contradictionOff
          ? 0
          : boundedNumber(contradictionWindowN, 1, Number.MAX_SAFE_INTEGER, 1, true),
        // Cadence: run detection every N turns (≥1). Irrelevant when off, but harmless to send.
        contradictionEveryNTurns: boundedNumber(
          contradictionEveryNTurns,
          1,
          Number.MAX_SAFE_INTEGER,
          1,
          true
        ),
        answerFitMode,
        extractionPrefilter,
        anonymousMode,
        // Access mode (who may start) + invitee fields — email is forced shown+required server-side.
        accessMode,
        inviteeFields,
        // Seriousness / abuse gate: non-genuine answers tolerated before abandon. Blank/invalid
        // falls back to the stored value (never silently 0); 0 = off.
        abuseThreshold: boundedNumber(abuseThreshold, 0, 50, config.abuseThreshold, true),
        // Data Slots feature: re-ask attempts before a slot is parked with a provisional fill.
        maxDataSlotAttempts: boundedNumber(
          maxDataSlotAttempts,
          1,
          10,
          config.maxDataSlotAttempts,
          true
        ),
        // Sensitivity awareness / safeguarding. Trim the copy; an empty support message disables
        // the signpost. Requires the platform sensitivity-awareness flag to take effect.
        sensitivityAwareness,
        supportMessage: supportMessage.trim(),
        supportResourceUrl: supportResourceUrl.trim(),
        answerSlotPanelScope,
        presentationMode,
        // Live "watch it think" reasoning stream (demo feature). Requires the platform
        // reasoning-stream flag to take effect.
        reasoningStreamEnabled,
        reasoningStreamPlacement,
        reasoningStreamPersist,
        // Preview Turn Inspector (admin-only). Surfaces only inside an admin preview session.
        previewInspectorEnabled,
        // Interviewer tone & persona (F-tone). Sent whole; trim the persona text. Requires the
        // platform tone flag to take effect.
        tone: { ...tone, persona: { ...tone.persona, text: tone.persona.text.trim() } },
        profileFields: profileFields.map((f) => ({
          key: f.key.trim(),
          label: f.label.trim(),
          type: f.type,
          required: f.required,
          ...(f.type === 'select' ? { options: parseOptions(f.optionsText) } : {}),
        })),
      },
    ]);

  return (
    <section className="space-y-4">
      {!config.saved && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="font-medium">Not yet saved.</span>
          <span>Save this configuration at least once before the version can be launched.</span>
        </div>
      )}

      {/* ── 1. Questions & completion — the core run loop: how questions are chosen and when a
             session is allowed to finish. Most-used knobs, so they lead. ── */}
      <SettingsGroup
        icon={ListChecks}
        accent="bg-blue-500/10 text-blue-600 dark:text-blue-400"
        title="Questions & completion"
        description="How the agent chooses the next question and when a session is allowed to finish."
      >
        <div className="space-y-1.5 sm:max-w-sm">
          <Label className="text-sm font-medium">
            Selection strategy{' '}
            <FieldHelp title="Selection strategy">
              How the agent picks the next question — in order, by question weight, or adaptively
              chosen from the conversation so far.
            </FieldHelp>
          </Label>
          <Select
            value={selectionStrategy}
            onValueChange={(v) => setSelectionStrategy(v as SelectionStrategy)}
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SELECTION_STRATEGIES.filter(
                // Hide adaptive when its sub-flag is off — unless it's the saved
                // value, so the Select still shows a label rather than blank.
                (s) =>
                  s !== 'adaptive' || adaptiveEnabled || config.selectionStrategy === 'adaptive'
              ).map((s) => (
                <SelectItem key={s} value={s}>
                  {SELECTION_STRATEGY_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Adaptive ranks questions by embedding similarity, so it needs the slots embedded
              first. Surface the explicit generate step + coverage as soon as the admin picks
              adaptive (driven by the live selection, not just the saved value). */}
          {selectionStrategy === 'adaptive' && (
            <AdaptiveEmbeddingStep
              questionnaireId={questionnaireId}
              versionId={versionId}
              busy={busy}
            />
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Min questions answered{' '}
              <FieldHelp title="Minimum questions answered">
                A session can&apos;t complete until at least this many questions have been answered.
                0 means no minimum.
              </FieldHelp>
            </Label>
            <Input
              type="number"
              min={0}
              value={minQuestionsAnswered}
              onChange={(e) => setMinQuestionsAnswered(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Coverage threshold{' '}
              <FieldHelp title="Coverage threshold">
                Fraction of (weighted) questions that must be covered to consider the session
                complete. 1 = all questions; 0.8 = 80%.
              </FieldHelp>
            </Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={coverageThreshold}
              onChange={(e) => setCoverageThreshold(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        <div className="space-y-1.5 sm:max-w-xs">
          <Label className="text-sm font-medium">
            Data-slot attempts{' '}
            <FieldHelp title="Data-slot attempts">
              How many times the agent asks about one data slot (topic) before it records its best
              guess and moves on — so a respondent never gets stuck being asked the same thing.{' '}
              <code className="text-xs">2</code> = ask once, then one sharper re-ask. The best guess
              is shown as &ldquo;provisional · may revisit&rdquo; and can still be refined later.
              Only applies in data-slot mode.
            </FieldHelp>
          </Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={maxDataSlotAttempts}
            onChange={(e) => setMaxDataSlotAttempts(e.target.value)}
            disabled={busy}
          />
        </div>
      </SettingsGroup>

      {/* ── 2. Respondent experience — how a person actually completes it (format, input, what
             they see, whether they're identified). ── */}
      <SettingsGroup
        icon={MessageSquareText}
        accent="bg-violet-500/10 text-violet-600 dark:text-violet-400"
        title="Respondent experience"
        description="How a respondent completes the questionnaire — format, input, and what they see alongside the chat."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Presentation mode{' '}
              <FieldHelp title="Presentation mode">
                How the respondent completes this questionnaire. Chat is the streaming conversation.
                Form presents the questions as a raw, sectioned form with the right input per type
                (likert, choices, yes/no, text…). Both offers a chat ↔ form toggle so the respondent
                can navigate sections, see what&apos;s already answered, and edit answers the agent
                inferred — a useful escape hatch when the chat struggles. Form mode is
                question-based: for questionnaires using data slots, editing a question reconciles
                into the chat on the next turn.
              </FieldHelp>
            </Label>
            <Select
              value={presentationMode}
              onValueChange={(v) => setPresentationMode(v as PresentationMode)}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESENTATION_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {PRESENTATION_MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Answer panel scope{' '}
              <FieldHelp title="Answer panel scope">
                How much of the questionnaire the live answer panel shows the respondent beside the
                chat. Full progress lists every question grouped by section with an answered-count;
                answered only shows just the answers captured so far.
              </FieldHelp>
            </Label>
            <Select
              value={answerSlotPanelScope}
              onValueChange={(v) => setAnswerSlotPanelScope(v as AnswerSlotPanelScope)}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANSWER_SLOT_PANEL_SCOPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {ANSWER_SLOT_PANEL_SCOPE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={voiceEnabled} onCheckedChange={setVoiceEnabled} disabled={busy} />
          <Label className="text-sm font-medium">
            Voice input{' '}
            <FieldHelp title="Voice input">
              Let respondents answer by voice as well as text — shows a mic button in the composer
              and tells them they can talk through their answers. When off, the mic is hidden and
              the agent never suggests it. Also requires the platform voice-input flag.
            </FieldHelp>
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={attachmentsEnabled}
            onCheckedChange={setAttachmentsEnabled}
            disabled={busy}
          />
          <Label className="text-sm font-medium">
            Attachments{' '}
            <FieldHelp title="Attachments">
              Let respondents attach files (images, documents) to their answers — shows a paperclip
              button in the composer. When off, the button is hidden and any attachments sent anyway
              are ignored. Also requires the platform attachment-input flag.
            </FieldHelp>
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={anonymousMode} onCheckedChange={setAnonymousMode} disabled={busy} />
          <Label className="text-sm font-medium">
            Anonymous mode{' '}
            <FieldHelp title="Anonymous mode">
              Don&apos;t collect identifying profile fields at session start — responses aren&apos;t
              tied to a named individual. This is the <em>identity</em> axis and is independent of{' '}
              <em>Access</em> (who may start): an anonymous questionnaire can still be
              invitation-only, and a named one can still be public. When anonymous, invitees are
              tracked only as started/completed — never linked to their answers.
            </FieldHelp>
          </Label>
        </div>
      </SettingsGroup>

      {/* ── 2b. Reasoning stream — the live "watch it think" demo feature. Sits with the respondent
             experience (it's a respondent-facing surface) but in its own group so the marquee toggle
             and its placement/persistence options are discoverable. ── */}
      <SettingsGroup
        icon={Brain}
        accent="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
        title="Reasoning stream"
        description="Show a live “watch it think” feed beside the chat — answers captured, contradictions spotted, and why the next question was chosen. Also requires the platform reasoning-stream flag."
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={reasoningStreamEnabled}
            onCheckedChange={setReasoningStreamEnabled}
            disabled={busy}
          />
          <Label className="text-sm font-medium">
            Show the reasoning stream{' '}
            <FieldHelp title="Reasoning stream">
              When on, the respondent sees the agent&apos;s per-turn reasoning as it works — answers
              it captured (and how confident it is), any contradictions it noticed, and why
              it&apos;s asking the next question. It&apos;s derived from work the conversation
              already does, so it adds no extra cost or latency. A great demo moment; turn it off
              for a plainer experience. Also requires the platform reasoning-stream flag to be on.
            </FieldHelp>
          </Label>
        </div>
        {reasoningStreamEnabled && (
          <div className="border-border/60 ml-1 space-y-4 border-l pl-4">
            <div className="space-y-1.5 sm:max-w-sm">
              <Label className="text-sm font-medium">
                Placement{' '}
                <FieldHelp title="Reasoning stream placement">
                  Where the feed appears. <strong>Live overlay</strong> animates the steps in place
                  of the typing dots while the agent works, then collapses to a small “reasoning”
                  chip on the finished turn — the most striking for a live demo.{' '}
                  <strong>Inline</strong> is quieter: a collapsible note tucked beneath each reply.
                </FieldHelp>
              </Label>
              <Select
                value={reasoningStreamPlacement}
                onValueChange={(v) => setReasoningStreamPlacement(v as ReasoningPlacement)}
                disabled={busy}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONING_PLACEMENTS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {REASONING_PLACEMENT_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={reasoningStreamPersist}
                onCheckedChange={setReasoningStreamPersist}
                disabled={busy}
              />
              <Label className="text-sm font-medium">
                Keep the reasoning on each turn{' '}
                <FieldHelp title="Persist the reasoning trace">
                  When on, each turn&apos;s reasoning is saved so it replays if the respondent
                  resumes the session or scrolls back — and is available to you afterwards. When
                  off, the feed is live-only: it shows as the turn happens, but resumed or earlier
                  turns show nothing.
                </FieldHelp>
              </Label>
            </div>
          </div>
        )}
      </SettingsGroup>

      {/* ── 2b-ii. Preview tools (admin only) — debugging surfaces that appear ONLY when an admin is
             previewing as a respondent, never to a real respondent. Server-enforced via the preview
             session marker, so this toggle can't leak telemetry to live sessions. ── */}
      <SettingsGroup
        icon={ScanSearch}
        accent="bg-[var(--cq-accent-muted)] text-[color:var(--cq-accent)]"
        title="Preview tools — admin only"
        description="Debugging surfaces shown only when you preview as a respondent. Never visible to real respondents."
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={previewInspectorEnabled}
            onCheckedChange={setPreviewInspectorEnabled}
            disabled={busy}
          />
          <Label className="text-sm font-medium">
            Turn inspector{' '}
            <FieldHelp title="Preview turn inspector (admin only)">
              When on, the &ldquo;Preview as respondent&rdquo; screen gains a collapsible{' '}
              <strong>Inspector</strong> drawer. For each turn it shows the sequence of agent calls
              the conversation made, and for each call the model used, response time, estimated
              cost, token counts, and the raw prompt and response. It appears <strong>only</strong>{' '}
              in a preview session — a real respondent never sees it and the data is never sent to
              them. Useful for understanding and debugging how the conversation is being driven.
            </FieldHelp>
          </Label>
        </div>
      </SettingsGroup>

      {/* ── 2c. Interviewer tone & persona — how the conversational interviewer responds. Each
             dimension is independent (toggle + 1–5 slider); persona casts the agent. Off by default
             and gated by the platform tone flag, so it's inert until both are switched on. ── */}
      <SettingsGroup
        icon={SlidersHorizontal}
        accent="bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400"
        title="Interviewer tone & persona"
        description="Shape how the conversational interviewer responds to answers — empathy, mirroring, formality, mimicry, verbosity and more. Each is off until you enable it; also requires the platform tone flag."
      >
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Switch
              checked={tone.persona.enabled}
              onCheckedChange={(v) => setTonePersona({ enabled: v })}
              disabled={busy}
            />
            <Label className="text-sm font-medium">
              Persona{' '}
              <FieldHelp title="Persona">
                Cast the interviewer in a role and it will speak from that perspective — for example
                “You are an experienced, supportive career coach” or “You are a concise management
                consultant.” Free text; keep it a sentence or two. The tone sliders below still
                apply on top of the persona.
              </FieldHelp>
            </Label>
          </div>
          {tone.persona.enabled && (
            <div className="border-border/60 ml-1 border-l pl-4">
              <Textarea
                value={tone.persona.text}
                onChange={(e) => setTonePersona({ text: e.target.value })}
                maxLength={TONE_PERSONA_MAX_LENGTH}
                rows={2}
                disabled={busy}
                placeholder="e.g. You are an experienced, supportive career coach."
                className="max-w-md"
              />
            </div>
          )}
        </div>

        {TONE_DIMENSION_META.map((meta) => (
          <ToneDimensionRow
            key={meta.key}
            meta={meta}
            value={tone[meta.key]}
            busy={busy}
            onToggle={(enabled) => setToneDimension(meta.key, { enabled })}
            onLevel={(level) => setToneDimension(meta.key, { level })}
          />
        ))}
      </SettingsGroup>

      {/* ── 3. Access & invitations — who may start, and the invitee detail fields captured. ── */}
      <SettingsGroup
        icon={Mail}
        accent="bg-amber-500/10 text-amber-600 dark:text-amber-400"
        title="Access & invitations"
        description="Who may start this questionnaire, and which invitee details the Invitations tab captures. Independent of Anonymous mode (the identity axis)."
      >
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">
            Access mode{' '}
            <FieldHelp title="Access mode">
              Who may start a session. Invitation only: a per-invitee link is required. Public link:
              anyone with the URL can answer. Both: either works. This is the <em>access</em> axis —
              separate from Anonymous mode (whether identity is collected).
            </FieldHelp>
          </Label>
          <Select
            value={accessMode}
            onValueChange={(v) => setAccessMode(v as AccessMode)}
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCESS_MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {ACCESS_MODE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">
            Invitee details{' '}
            <FieldHelp title="Invitee details">
              Which fields the Invitations tab captures per person (and which are required). Email
              is always collected. Shown fields appear as columns in the import/verify grid;
              required fields must be filled before sending.
            </FieldHelp>
          </Label>
          <ul className="divide-border/60 divide-y rounded-md border">
            {inviteeFields.map((field) => {
              const locked = field.key === 'email';
              return (
                <li key={field.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-28 flex-1 font-medium">
                    {INVITEE_FIELD_LABELS[field.key]}
                    {locked ? (
                      <span className="text-muted-foreground ml-1 text-xs">(always on)</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Switch
                      aria-label={`${INVITEE_FIELD_LABELS[field.key]} shown`}
                      checked={locked ? true : field.shown}
                      disabled={busy || locked}
                      onCheckedChange={(shown) =>
                        setInviteeFields((prev) =>
                          prev.map((f) =>
                            f.key === field.key
                              ? { ...f, shown, required: shown ? f.required : false }
                              : f
                          )
                        )
                      }
                    />
                    <span className="text-muted-foreground text-xs">Shown</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Switch
                      aria-label={`${INVITEE_FIELD_LABELS[field.key]} required`}
                      checked={locked ? true : field.required}
                      disabled={busy || locked || !field.shown}
                      onCheckedChange={(required) =>
                        setInviteeFields((prev) =>
                          prev.map((f) => (f.key === field.key ? { ...f, required } : f))
                        )
                      }
                    />
                    <span className="text-muted-foreground text-xs">Required</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </SettingsGroup>

      {/* ── 4. Answer quality & safeguarding — protective / data-integrity features: sensitive
             disclosures, the seriousness gate, and contradiction detection. ── */}
      <SettingsGroup
        icon={ShieldCheck}
        accent="bg-rose-500/10 text-rose-600 dark:text-rose-400"
        title="Answer quality & safeguarding"
        description="Protective and data-integrity features: handling sensitive disclosures, ending abusive sessions, and catching contradictions. Each also requires its platform flag."
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch
              checked={sensitivityAwareness}
              onCheckedChange={setSensitivityAwareness}
              disabled={busy}
            />
            <Label className="text-sm font-medium">
              Sensitivity awareness{' '}
              <FieldHelp title="Sensitivity awareness">
                When on, the agent notices a sensitive or contentious disclosure (e.g. abuse,
                distress, a safeguarding concern), remembers it, and treads carefully in how it
                phrases every later question. Best-effort awareness, not a guaranteed safeguarding
                net. Requires the platform sensitivity-awareness flag to be on.
              </FieldHelp>
            </Label>
          </div>
          {sensitivityAwareness && (
            <div className="border-border/60 ml-1 space-y-3 border-l pl-4">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  Support message{' '}
                  <FieldHelp title="Support message">
                    Shown once, gently, when a serious disclosure is detected — verbatim, so it
                    can&apos;t be reworded by the agent. Leave blank to use a standard support
                    message; or write your own, e.g. &ldquo;If anything here has been difficult,
                    support is available — you can reach our team or a helpline at any time.&rdquo;
                  </FieldHelp>
                </Label>
                <Textarea
                  rows={2}
                  value={supportMessage}
                  onChange={(e) => setSupportMessage(e.target.value)}
                  placeholder="If anything here has been difficult, support is available…"
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5 sm:max-w-md">
                <Label className="text-sm font-medium">
                  Support resource URL{' '}
                  <FieldHelp title="Support resource URL">
                    Optional link appended to the support message (e.g. a helpline or wellbeing
                    page). Must be a valid URL.
                  </FieldHelp>
                </Label>
                <Input
                  type="url"
                  value={supportResourceUrl}
                  onChange={(e) => setSupportResourceUrl(e.target.value)}
                  placeholder="https://…"
                  disabled={busy}
                />
              </div>
            </div>
          )}
        </div>

        <div className="space-y-1.5 sm:max-w-xs">
          <Label className="text-sm font-medium">
            Abuse threshold{' '}
            <FieldHelp title="Abuse threshold">
              How many non-genuine answers (preposterous, abusive, or off-topic) a respondent may
              give before the session is automatically ended. Earlier strikes get escalating
              warnings and the answer is set aside; the Nth ends the session. Colloquial or lazy
              answers are tolerated. Set to <code className="text-xs">0</code> to turn the gate off.
              Requires the platform seriousness-gate flag to be on.
            </FieldHelp>
          </Label>
          <Input
            type="number"
            min={0}
            max={50}
            value={abuseThreshold}
            onChange={(e) => setAbuseThreshold(e.target.value)}
            disabled={busy}
          />
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5 sm:max-w-sm">
            <Label className="text-sm font-medium">
              Contradiction detection{' '}
              <FieldHelp title="Contradiction detection">
                Whether the agent watches for answers that contradict earlier ones — off, flag them,
                or probe with a follow-up.
              </FieldHelp>
            </Label>
            <Select
              value={contradictionMode}
              onValueChange={(v) => setContradictionMode(v as ContradictionMode)}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTRADICTION_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {CONTRADICTION_MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!contradictionOff && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  Look-back window (N){' '}
                  <FieldHelp title="Look-back window">
                    How many prior answers to check each new answer against. Must be at least 1 when
                    detection is on.
                  </FieldHelp>
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={contradictionWindowN}
                  onChange={(e) => setContradictionWindowN(e.target.value)}
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  Detection cadence (every N turns){' '}
                  <FieldHelp title="Detection cadence">
                    How often to run contradiction detection during the conversation — every N
                    respondent turns. 1 runs it every turn (most thorough); a higher value trades
                    some immediacy for lower per-turn cost. The completion sweep always runs
                    regardless.
                  </FieldHelp>
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={contradictionEveryNTurns}
                  onChange={(e) => setContradictionEveryNTurns(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>
          )}
          <div className="space-y-1.5 sm:max-w-sm">
            <Label className="text-sm font-medium">
              Answer fit resolver{' '}
              <FieldHelp title="Answer fit resolver">
                A second, focused pass that maps a free-form answer onto a choice or scale option
                the first pass couldn&apos;t place — e.g. &ldquo;Marketing&rdquo; to the
                &ldquo;Other&rdquo; option, or &ldquo;10 years&rdquo; to the &ldquo;3+ years&rdquo;
                band. <strong>Fallback</strong> runs it only when a clearly-given answer didn&apos;t
                map (no extra cost otherwise). <strong>Always</strong> also tries to fill any
                still-open choice/scale question each turn (more thorough, one extra model call per
                answered turn). <strong>Off</strong> disables it.
              </FieldHelp>
            </Label>
            <Select
              value={answerFitMode}
              onValueChange={(v) => setAnswerFitMode(v as AnswerFitMode)}
              disabled={busy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANSWER_FIT_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {ANSWER_FIT_MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Switch
              checked={extractionPrefilter}
              onCheckedChange={setExtractionPrefilter}
              disabled={busy}
            />
            <Label className="text-sm font-medium">
              Extraction pre-filter{' '}
              <FieldHelp title="Extraction pre-filter">
                Each turn, narrows the candidate slots the answer extractor reads to the active
                slot, already-filled slots, same-theme slots, mapped questions, and the most similar
                to what the respondent just said — cutting per-turn prompt cost on big
                questionnaires. Spends one embedding call per turn and is fail-soft (any embedding
                error falls back to the full candidate set).{' '}
                <strong>Recommended for large surveys</strong> (roughly 50+ data slots / 70+
                questions); leave off for smaller ones, where sending the full set is cheap and
                maximises capture accuracy. Off by default.
              </FieldHelp>
            </Label>
          </div>
        </div>
      </SettingsGroup>

      {/* ── 4. Budget & limits — cost control and hard caps, with the pre-launch estimate. ── */}
      <SettingsGroup
        icon={Gauge}
        accent="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        title="Budget & limits"
        description="Cost control and hard caps on a single session, with a pre-launch spend estimate."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Cost budget (USD / session){' '}
              <FieldHelp title="Cost budget">
                Optional per-session spend cap in US dollars. Leave blank for no cap. (Enforcement
                lands with the turn engine; the estimate below shows projected spend against this
                cap.)
              </FieldHelp>
            </Label>
            <Input
              type="number"
              min={0}
              step={0.01}
              placeholder="No cap"
              value={costBudgetUsd}
              onChange={(e) => setCostBudgetUsd(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Max questions / session{' '}
              <FieldHelp title="Per-session question cap">
                Hard limit on how many questions a single session will ask. Leave blank for no cap.
              </FieldHelp>
            </Label>
            <Input
              type="number"
              min={1}
              placeholder="No cap"
              value={maxQuestionsPerSession}
              onChange={(e) => setMaxQuestionsPerSession(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>
        {/* Pre-launch cost estimate (F3.3) — reads persisted config, so it re-fetches
            when the saved cap/floor change. Compares against the live (possibly
            unsaved) budget input. */}
        <CostEstimateCard
          questionnaireId={questionnaireId}
          versionId={versionId}
          reloadKey={`${config.saved}:${config.maxQuestionsPerSession}:${config.minQuestionsAnswered}:${questionCount}`}
          costBudgetUsd={capOrNull(costBudgetUsd, false)}
        />
      </SettingsGroup>

      {/* ── 5. Session-start profile fields — what to collect before the questionnaire begins.
             Last: optional, set-up-once metadata rather than run-time behaviour. ── */}
      <SettingsGroup
        icon={ClipboardList}
        accent="bg-slate-500/10 text-slate-600 dark:text-slate-300"
        title="Session-start profile fields"
        description="Fields collected from the respondent before the questionnaire begins. Optional — leave empty to start straight into the conversation."
      >
        {profileFields.length === 0 ? (
          <p className="text-muted-foreground text-sm italic">No profile fields.</p>
        ) : (
          <div className="space-y-3">
            {profileFields.map((field, index) => (
              <div key={index} className="bg-muted/20 space-y-2 rounded-md border p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Key</Label>
                    <Input
                      value={field.key}
                      placeholder="e.g. organisation"
                      onChange={(e) => updateField(index, { key: e.target.value })}
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Label</Label>
                    <Input
                      value={field.label}
                      placeholder="e.g. Organisation"
                      onChange={(e) => updateField(index, { label: e.target.value })}
                      disabled={busy}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Type</Label>
                    <Select
                      value={field.type}
                      onValueChange={(v) => updateField(index, { type: v as ProfileFieldType })}
                      disabled={busy}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROFILE_FIELD_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {PROFILE_FIELD_TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2 pt-5">
                    <Switch
                      checked={field.required}
                      onCheckedChange={(checked) => updateField(index, { required: checked })}
                      disabled={busy}
                    />
                    <Label className="text-xs">Required</Label>
                  </div>
                </div>
                {field.type === 'select' && (
                  <div className="space-y-1">
                    <Label className="text-xs">
                      Options{' '}
                      <FieldHelp title="Select options">
                        Comma-separated list of choices the respondent picks from.
                      </FieldHelp>
                    </Label>
                    <Input
                      value={field.optionsText}
                      placeholder="e.g. Engineering, Sales, Support"
                      onChange={(e) => updateField(index, { optionsText: e.target.value })}
                      disabled={busy}
                    />
                  </div>
                )}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeField(index)}
                    disabled={busy}
                  >
                    <X className="mr-1 h-3 w-3" /> Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <Button type="button" variant="outline" size="sm" onClick={addField} disabled={busy}>
          <Plus className="mr-1 h-4 w-4" /> Add profile field
        </Button>
      </SettingsGroup>

      {/* Save footer — one mutation sends the whole config; sticks to the bottom of the panel so
          the action is reachable without scrolling back up through five groups. */}
      <div className="bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t px-1 py-3 backdrop-blur">
        {!config.saved && (
          <span className="text-muted-foreground text-xs">Unsaved — required before launch</span>
        )}
        <SaveButton size="sm" disabled={busy} onSave={save}>
          Save configuration
        </SaveButton>
      </div>
    </section>
  );
}
