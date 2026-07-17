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

import { useEffect, useMemo, useState } from 'react';
import {
  Brain,
  ClipboardList,
  ChevronRight,
  Compass,
  Gauge,
  Hash,
  List,
  ListChecks,
  Mail,
  MessageSquareText,
  PanelTop,
  Plus,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  Type as TypeIcon,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfigImportExport } from '@/components/admin/questionnaires/config-import-export';
import { SaveButton } from '@/components/admin/questionnaires/save-button';
import { Input } from '@/components/ui/input';
import { PublicRespondentLink } from '@/components/admin/questionnaires/public-respondent-link';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import {
  detectConfigConflicts,
  type ConfigConflict,
} from '@/lib/app/questionnaire/authoring/config-conflicts';
import {
  ConfigConflictBanner,
  SectionConflicts,
} from '@/components/admin/questionnaires/config-conflicts';
import { cn } from '@/lib/utils';
import { SectionRail } from '@/components/admin/section-rail';
import { CostEstimateCard } from '@/components/admin/questionnaires/cost-estimate-card';
import { AdaptiveEmbeddingStep } from '@/components/admin/questionnaires/adaptive-embedding-step';
import { DataSlotEmbeddingStep } from '@/components/admin/questionnaires/data-slot-embedding-step';
import { IntroBackgroundField } from '@/components/admin/questionnaires/intro-background-field';
import {
  TONE_DIMENSION_META,
  ToneDimensionRow,
} from '@/components/admin/questionnaires/tone-dimensions';
import {
  PersonaLibraryPanel,
  PersonaLibraryIcon,
} from '@/components/admin/questionnaires/persona-library-panel';
import { BUILT_IN_PERSONAS } from '@/lib/app/questionnaire/persona/presets';
import { personaToneClause } from '@/lib/app/questionnaire/chat/tone';
import { API } from '@/lib/api/endpoints';
import {
  ACCESS_MODES,
  ACCESS_MODE_LABELS,
  ANSWER_FIT_MODES,
  ANSWER_SLOT_PANEL_SCOPES,
  CAPTURE_MODES,
  CONTRADICTION_MODES,
  INTRO_BUTTON_LABEL_MAX_LENGTH,
  INTRO_VIDEO_URL_MAX_LENGTH,
  INVITEE_FIELD_LABELS,
  PRESENTATION_MODES,
  PROFILE_FIELD_TYPES,
  PROFILE_FIELD_VALIDATION_MODES,
  REASONING_PLACEMENTS,
  TONE_PERSONA_MAX_LENGTH,
  type AccessMode,
  type CaptureMode,
  type IntroSettings,
  type AnswerFitMode,
  type AnswerSlotPanelScope,
  type ContradictionMode,
  type InviteeFieldConfig,
  type PresentationMode,
  type ProfileFieldConfig,
  type ProfileFieldType,
  type ProfileFieldValidationMode,
  type ReasoningPlacement,
  type SelectionStrategy,
  type ToneDimension,
  type ToneDimensionKey,
  type ToneSettings,
  type PersonaSelectionSettings,
  INTERVIEWER_APPROACHES,
  INTERVIEWER_APPROACH_LABELS,
  type InterviewerApproach,
  type InterviewerStrategySettings,
} from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

const SELECTION_STRATEGY_LABELS: Record<SelectionStrategy, string> = {
  sequential: 'Sequential (in order)',
  random: 'Random (shuffled)',
  weighted: 'Weighted (by question weight)',
  adaptive: 'Adaptive (agent-chosen)',
};

/**
 * Display order for the Selection strategy dropdown — Adaptive first (the most capable / recommended
 * strategy), then the deterministic ones. Deliberately distinct from the canonical
 * `SELECTION_STRATEGIES` order (which drives validation/types), so reordering the menu can't shift
 * any default. Any strategy missing here would simply not render, so keep it exhaustive.
 */
const SELECTION_STRATEGY_ORDER: SelectionStrategy[] = [
  'adaptive',
  'sequential',
  'random',
  'weighted',
];

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

const PROFILE_FIELD_TYPE_ICONS: Record<ProfileFieldType, LucideIcon> = {
  text: TypeIcon,
  email: Mail,
  number: Hash,
  select: List,
};

const PROFILE_FIELD_VALIDATION_MODE_LABELS: Record<ProfileFieldValidationMode, string> = {
  deterministic: 'Format only',
  agentic: 'AI (tidy + flag)',
  hybrid: 'Both (format + AI)',
};

/** Short labels for the compact segmented placement controls. */
const CAPTURE_MODE_SHORT_LABELS: Record<CaptureMode, string> = {
  form: 'Form',
  conversational: 'Conversation',
};

/** Icon per placement — form = a panel at the top of the flow, conversation = a chat bubble. */
const CAPTURE_MODE_ICONS: Record<CaptureMode, LucideIcon> = {
  form: PanelTop,
  conversational: MessageSquareText,
};

/** Lowercase a label into a valid profile-field key (`^[a-z0-9_]+$`); '' when nothing usable. */
function slugifyFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/** A plain-English one-liner describing how a field is collected — the live preview under each card. */
function describeProfileField(
  field: { type: ProfileFieldType; required: boolean; captureVia?: CaptureMode },
  defaultMode: CaptureMode
): string {
  const placement = field.captureVia ?? defaultMode;
  const where =
    placement === 'form'
      ? 'on the form, before the conversation'
      : 'naturally during the conversation';
  const necessity = field.required ? 'Required' : 'Optional';
  const kind = PROFILE_FIELD_TYPE_LABELS[field.type].toLowerCase().replace(' (choices)', '');
  return `${necessity} · asked as ${field.type === 'email' ? 'an' : 'a'} ${kind} answer, collected ${where}.`;
}

/**
 * A compact segmented control (radiogroup) — the whole option set is visible at once, so a
 * placement choice reads as "these are the options, this is the current one" rather than a dropdown
 * that hides its alternatives. Used for the version default and each field's placement override.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  size = 'md',
}: {
  value: T;
  options: { value: T; label: string; icon?: LucideIcon; hint?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  size?: 'md' | 'sm';
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="border-border/70 bg-muted/40 inline-flex flex-wrap items-center gap-1 rounded-lg border p-1"
    >
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 font-medium transition-colors',
              size === 'sm' ? 'h-7 text-xs' : 'h-8 text-sm',
              active
                ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5'
                : 'text-muted-foreground hover:text-foreground',
              disabled && 'cursor-not-allowed opacity-50'
            )}
          >
            {Icon && <Icon className={cn(size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')} aria-hidden />}
            {o.label}
            {o.hint && <span className="text-muted-foreground/70 font-normal">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

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
  overlay: 'Animated (opens, then tucks away)',
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
  /** How the value is validated (deterministic / agentic / hybrid). */
  validation: ProfileFieldValidationMode;
  /** Where this field is collected, overriding the default. `undefined` = inherit the default mode. */
  captureVia?: CaptureMode;
  /**
   * UI-only: has the admin hand-edited the key? A fresh field auto-derives its key from the label
   * (so "Key" stops being a thing to think about); once the admin edits the key directly — or the
   * field was loaded from a saved config — we stop touching it, because the key is the stored answer's
   * handle and silently changing it on an existing field would orphan collected data.
   */
  keyTouched: boolean;
  /** UI-only: is this field's editor expanded? Loaded/seeded fields start collapsed to keep the list
   *  scannable; a freshly-added field opens expanded so it can be filled in straight away. */
  expanded: boolean;
}

function toRow(field: ProfileFieldConfig): ProfileFieldRow {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    optionsText: (field.options ?? []).join(', '),
    validation: field.validation,
    captureVia: field.captureVia,
    // A saved field's key is locked — it already keys stored answers, so the label must not rewrite it.
    keyTouched: true,
    expanded: false,
  };
}

/**
 * The starter set seeded when an admin first turns capture on — the fields most questionnaires want,
 * with sensible required/optional defaults. Fresh rows (locked keys, collapsed) the admin can then
 * trim or extend. A function, not a constant, so each seed is an independent, mutable copy.
 */
function defaultProfileFieldRows(): ProfileFieldRow[] {
  const base = {
    optionsText: '',
    validation: 'deterministic' as const,
    keyTouched: true,
    expanded: false,
  };
  return [
    { key: 'name', label: 'Name', type: 'text', required: true, ...base },
    { key: 'email', label: 'Email address', type: 'email', required: true, ...base },
    { key: 'phone', label: 'Phone number', type: 'text', required: false, ...base },
    { key: 'organisation', label: 'Organisation', type: 'text', required: false, ...base },
  ];
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
 * Coverage is stored as a 0–1 fraction but shown to admins as a whole percent (0–100) — a
 * `0.05`-vs-`5%` mismatch was a real source of confusion. These two helpers convert at the UI
 * boundary: `pctString` for the input's initial/resync value, `fractionFromPct` on save.
 */
const pctString = (fraction: number): string => String(Math.round(fraction * 100));

/** Parse a whole-percent input back to a stored 0–1 fraction (blank/garbage → `fallbackFraction`). */
function fractionFromPct(value: string, fallbackFraction: number): number {
  return boundedNumber(value, 0, 100, fallbackFraction * 100) / 100;
}

/**
 * A titled, icon-led group of related settings — the unit of organisation on the Settings tab.
 * Purely presentational: a card with a tinted icon chip, a one-line description, and the fields as
 * children. Grouping + ordering (most-used first) is what makes the long config scannable.
 */
function SettingsGroup({
  id,
  icon: Icon,
  accent,
  title,
  description,
  headerAction,
  conflicts,
  children,
}: {
  /** Anchor id + scroll-spy target — picked up by the `SectionRail`. */
  id: string;
  icon: LucideIcon;
  /** Tailwind classes tinting the icon chip — one hue per group, for at-a-glance scanning. */
  accent: string;
  title: string;
  description: string;
  /** Optional right-aligned control in the header (e.g. an enable/disable switch). */
  headerAction?: React.ReactNode;
  /** Active config conflicts anchored to this section — rendered as inline alerts atop the body. */
  conflicts?: ConfigConflict[];
  children: React.ReactNode;
}) {
  return (
    <Card
      id={id}
      data-section-rail
      data-section-label={title}
      className="scroll-mt-24 overflow-hidden shadow-sm"
    >
      <CardHeader className="bg-muted/30 flex-row items-start gap-3 space-y-0 border-b p-4">
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            accent
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          <CardDescription className="text-xs leading-relaxed">{description}</CardDescription>
        </div>
        {headerAction && <div className="mt-0.5 shrink-0">{headerAction}</div>}
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {conflicts && conflicts.length > 0 && <SectionConflicts conflicts={conflicts} />}
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * The either/or mode selector for the "Interviewer tone & persona" group — a two-option segmented
 * radio. "Custom voice" hand-tunes the tone dials + persona prose (`personaSelection.enabled` off);
 * "Built-in persona" hands the interviewer to a library persona (`enabled` on). Only rendered when
 * the persona-selection sub-flag is on — when off there is no choice, just the custom tone editor.
 */
function VoiceModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: 'custom' | 'persona';
  onChange: (mode: 'custom' | 'persona') => void;
  disabled: boolean;
}) {
  const options: { id: 'custom' | 'persona'; label: string; hint: string; icon: LucideIcon }[] = [
    {
      id: 'custom',
      label: 'Custom voice',
      hint: 'Hand-tune tone & persona',
      icon: SlidersHorizontal,
    },
    {
      id: 'persona',
      label: 'Built-in persona',
      hint: 'Pick from the library',
      icon: PersonaLibraryIcon,
    },
  ];
  return (
    <div role="radiogroup" aria-label="Interviewer voice" className="grid gap-2 sm:grid-cols-2">
      {options.map((opt) => {
        const active = mode === opt.id;
        const Icon = opt.icon;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            className={cn(
              'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
              active
                ? 'border-fuchsia-500/60 bg-fuchsia-500/5 ring-1 ring-fuchsia-500/30'
                : 'border-border hover:bg-muted/40',
              disabled && 'cursor-not-allowed opacity-60'
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                active
                  ? 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span>
              <span className="block text-sm font-medium">{opt.label}</span>
              <span className="text-muted-foreground block text-xs">{opt.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ConfigEditor({
  questionnaireId,
  versionId,
  config,
  questionCount,
  isVersionLaunched = false,
  run,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  config: ConfigView;
  /** Live question count on the version — folded into the estimate's reload key so it refreshes after question edits. */
  questionCount: number;
  /**
   * Whether the version being edited is launched. Drives only the public-link helper note
   * (a draft version's `/q/<versionId>` link won't boot a session until launch). Defaults to
   * `false` for non-questionnaire mounts.
   */
  isVersionLaunched?: boolean;
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
  const [answerConfidenceFloor, setAnswerConfidenceFloor] = useState(
    String(config.answerConfidenceFloor)
  );
  const [allowEarlyFinish, setAllowEarlyFinish] = useState(config.allowEarlyFinish);
  // Shown as a whole percent (0–100); stored as a 0–1 fraction. See `pctString` / `fractionFromPct`.
  const [earlyFinishMinCoveragePct, setEarlyFinishMinCoveragePct] = useState(
    pctString(config.earlyFinishMinCoverage)
  );
  const [earlyFinishMinQuestions, setEarlyFinishMinQuestions] = useState(
    String(config.earlyFinishMinQuestions)
  );
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
  const [captureMode, setCaptureMode] = useState<CaptureMode>(config.captureMode);
  const [inlineCorrectionEnabled, setInlineCorrectionEnabled] = useState(
    config.inlineCorrectionEnabled
  );
  const [sessionResumeEnabled, setSessionResumeEnabled] = useState(config.sessionResumeEnabled);
  const [reasoningStreamEnabled, setReasoningStreamEnabled] = useState(
    config.reasoningStreamEnabled
  );
  const [reasoningStreamPlacement, setReasoningStreamPlacement] = useState<ReasoningPlacement>(
    config.reasoningStreamPlacement
  );
  const [reasoningStreamDwellMs, setReasoningStreamDwellMs] = useState(
    String(config.reasoningStreamDwellMs)
  );
  const [reasoningStreamPerItemMs, setReasoningStreamPerItemMs] = useState(
    String(config.reasoningStreamPerItemMs)
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
  // Whether respondent-profile capture is on at all (off by default). Derived from "has any field" —
  // an empty `profileFields` is exactly how the runtime already reads "don't collect", so no separate
  // stored flag / migration is needed. Kept as its own state (not recomputed from length) so toggling
  // off can hide the fields without discarding them mid-edit; the save maps to `[]` when off.
  const [captureEnabled, setCaptureEnabled] = useState(config.profileFields.length > 0);
  // Interviewer tone & persona (F-tone): the whole block edited as one object. Helpers below patch
  // a single dimension / the persona immutably.
  const [tone, setTone] = useState<ToneSettings>(config.tone);
  // Selectable interviewer personas (F-persona): only the respondent-selection toggle + default key
  // are editable. The persona library itself is fixed (BUILT_IN_PERSONAS), so there's no editable
  // persona state — the panel reads the built-ins for its dropdown + read-only preview.
  const [personaSelection, setPersonaSelection] = useState<PersonaSelectionSettings>(
    config.personaSelection
  );
  // Interviewer strategy (questioning approach) — edited as one object, patched by `setStrategy`.
  const [interviewerStrategy, setInterviewerStrategy] = useState<InterviewerStrategySettings>(
    config.interviewerStrategy
  );
  // Respondent intro / splash (admin opt-in): the whole block edited as one object.
  const [intro, setIntro] = useState<IntroSettings>(config.intro);

  // Resync from the server graph after each refetch (mirrors version-editor.tsx).
  useEffect(() => {
    setSelectionStrategy(config.selectionStrategy);
    setMinQuestionsAnswered(String(config.minQuestionsAnswered));
    setCoverageThreshold(String(config.coverageThreshold));
    setAnswerConfidenceFloor(String(config.answerConfidenceFloor));
    setAllowEarlyFinish(config.allowEarlyFinish);
    setEarlyFinishMinCoveragePct(pctString(config.earlyFinishMinCoverage));
    setEarlyFinishMinQuestions(String(config.earlyFinishMinQuestions));
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
    setCaptureMode(config.captureMode);
    setInlineCorrectionEnabled(config.inlineCorrectionEnabled);
    setSessionResumeEnabled(config.sessionResumeEnabled);
    setReasoningStreamEnabled(config.reasoningStreamEnabled);
    setReasoningStreamPlacement(config.reasoningStreamPlacement);
    setReasoningStreamDwellMs(String(config.reasoningStreamDwellMs));
    setReasoningStreamPerItemMs(String(config.reasoningStreamPerItemMs));
    setReasoningStreamPersist(config.reasoningStreamPersist);
    setPreviewInspectorEnabled(config.previewInspectorEnabled);
    setProfileFields(config.profileFields.map(toRow));
    setCaptureEnabled(config.profileFields.length > 0);
    setTone(config.tone);
    setPersonaSelection(config.personaSelection);
    setInterviewerStrategy(config.interviewerStrategy);
    setIntro(config.intro);
  }, [config]);

  const contradictionOff = contradictionMode === 'off';

  // Tone edit helpers — patch one dimension's toggle/level or the persona, immutably.
  const setToneDimension = (key: ToneDimensionKey, patch: Partial<ToneDimension>) =>
    setTone((t) => ({ ...t, [key]: { ...t[key], ...patch } }));
  const setTonePersona = (patch: Partial<ToneSettings['persona']>) =>
    setTone((t) => ({ ...t, persona: { ...t.persona, ...patch } }));
  const setStrategy = (patch: Partial<InterviewerStrategySettings>) =>
    setInterviewerStrategy((s) => ({ ...s, ...patch }));

  const setPersonaSelectionPatch = (patch: Partial<PersonaSelectionSettings>) =>
    setPersonaSelection((s) => ({ ...s, ...patch }));

  const updateField = (index: number, patch: Partial<ProfileFieldRow>) =>
    setProfileFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  // Editing the label auto-fills the key (slugified) until the admin has hand-edited the key — so a
  // fresh field's key just tracks the label and the admin never has to think about it.
  const updateFieldLabel = (index: number, label: string) =>
    setProfileFields((prev) =>
      prev.map((f, i) =>
        i === index ? { ...f, label, key: f.keyTouched ? f.key : slugifyFieldKey(label) } : f
      )
    );

  // Hand-editing the key locks it (keyTouched) so later label edits stop rewriting it.
  const updateFieldKey = (index: number, key: string) =>
    setProfileFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, key, keyTouched: true } : f))
    );

  // Accordion: a new field opens expanded and collapses every existing one, so only one editor is
  // ever open at a time.
  const addField = () =>
    setProfileFields((prev) => [
      ...prev.map((f) => ({ ...f, expanded: false })),
      {
        key: '',
        label: '',
        type: 'text',
        required: false,
        optionsText: '',
        validation: 'deterministic',
        keyTouched: false,
        expanded: true,
      },
    ]);

  const removeField = (index: number) =>
    setProfileFields((prev) => prev.filter((_, i) => i !== index));

  // Accordion: expanding a field collapses all others; clicking the open one just closes it.
  const toggleFieldExpanded = (index: number) =>
    setProfileFields((prev) =>
      prev.map((f, i) => ({ ...f, expanded: i === index ? !f.expanded : false }))
    );

  const collapseAllFields = () =>
    setProfileFields((prev) => prev.map((f) => ({ ...f, expanded: false })));

  // Turn capture on/off. Turning it on for the first time (no fields yet) seeds the common starter set
  // so the admin lands on a working setup rather than a blank slate; turning it off keeps the fields in
  // state (so a mis-click is recoverable before saving) but the save writes `[]`.
  const toggleCaptureEnabled = (enabled: boolean) => {
    setCaptureEnabled(enabled);
    if (enabled && profileFields.length === 0) setProfileFields(defaultProfileFieldRows());
  };

  // Live conflict detection over the CURRENT editor state — recomputed as the admin edits, so a
  // contradictory combination (e.g. profile fields on an anonymous version) is flagged inline and in
  // the summary banner the moment it exists. Pure + cheap; the memo just avoids re-running on unrelated
  // re-renders. `conflictsBySection` buckets them for the per-section alerts.
  const conflicts = useMemo(
    () =>
      detectConfigConflicts({
        anonymousMode,
        presentationMode,
        captureEnabled,
        captureMode,
        profileFields,
        personaSelectionEnabled: personaSelection.enabled,
        reasoningStreamEnabled,
        voiceInputEnabled: voiceEnabled,
        attachmentInputEnabled: attachmentsEnabled,
        minQuestionsAnswered: boundedNumber(
          minQuestionsAnswered,
          0,
          Number.MAX_SAFE_INTEGER,
          0,
          true
        ),
        questionCount,
        sensitivityAwareness,
        supportMessage,
      }),
    [
      anonymousMode,
      presentationMode,
      captureEnabled,
      captureMode,
      profileFields,
      personaSelection.enabled,
      reasoningStreamEnabled,
      voiceEnabled,
      attachmentsEnabled,
      minQuestionsAnswered,
      questionCount,
      sensitivityAwareness,
      supportMessage,
    ]
  );
  const conflictsFor = (sectionId: string) => conflicts.filter((c) => c.sectionId === sectionId);

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
        allowEarlyFinish,
        // Percent input → stored 0–1 fraction.
        earlyFinishMinCoverage: fractionFromPct(
          earlyFinishMinCoveragePct,
          config.earlyFinishMinCoverage
        ),
        earlyFinishMinQuestions: boundedNumber(
          earlyFinishMinQuestions,
          0,
          Number.MAX_SAFE_INTEGER,
          config.earlyFinishMinQuestions,
          true
        ),
        answerConfidenceFloor: boundedNumber(
          answerConfidenceFloor,
          0,
          1,
          config.answerConfidenceFloor
        ),
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
        // Inline answer correction (Variant B): respondent-facing UX, no platform flag.
        inlineCorrectionEnabled,
        // Session resume: device-remember + Continue/Start-new chooser + by-ref resume. No platform flag.
        sessionResumeEnabled,
        // Live "watch it think" reasoning stream (demo feature). Requires the platform
        // reasoning-stream flag to take effect.
        reasoningStreamEnabled,
        reasoningStreamPlacement,
        // "Animated" timing (ms): base dwell (≤2 steps) + extra per step beyond two. Bounds mirror
        // the config schema; blank/garbage falls back to the stored value rather than weakening it.
        reasoningStreamDwellMs: boundedNumber(
          reasoningStreamDwellMs,
          0,
          10000,
          config.reasoningStreamDwellMs,
          true
        ),
        reasoningStreamPerItemMs: boundedNumber(
          reasoningStreamPerItemMs,
          0,
          5000,
          config.reasoningStreamPerItemMs,
          true
        ),
        reasoningStreamPersist,
        // Preview Turn Inspector (admin-only). Surfaces only inside an admin preview session.
        previewInspectorEnabled,
        // Interviewer tone & persona (F-tone). Sent whole; trim the persona text. Requires the
        // platform tone flag to take effect.
        tone: { ...tone, persona: { ...tone.persona, text: tone.persona.text.trim() } },
        // Respondent persona selection (F-persona). Only the on/off toggle + default key are stored;
        // the persona library is fixed (BUILT_IN_PERSONAS), never sent. Requires the platform
        // persona-selection flag AND `personaSelection.enabled` to surface to a respondent.
        personaSelection,
        // Interviewer strategy (questioning approach). Sent whole; off ⇒ default prompts unchanged.
        interviewerStrategy,
        // Respondent intro / splash. Sent whole; trim the background + button label. Requires the
        // platform intro-screen flag AND `enabled` to surface to a respondent.
        intro: {
          enabled: intro.enabled,
          background: intro.background.trim(),
          buttonLabel: intro.buttonLabel.trim(),
          videoUrl: intro.videoUrl.trim(),
        },
        captureMode,
        // Capture off → send no fields (exactly how the runtime reads "don't collect"), keeping the
        // in-editor rows so a re-enable before the next save restores them.
        profileFields: captureEnabled
          ? profileFields.map((f) => ({
              key: f.key.trim(),
              label: f.label.trim(),
              type: f.type,
              required: f.required,
              validation: f.validation,
              // Only send an override when set — an absent `captureVia` inherits the default placement.
              ...(f.captureVia ? { captureVia: f.captureVia } : {}),
              ...(f.type === 'select' ? { options: parseOptions(f.optionsText) } : {}),
            }))
          : [],
      },
    ]);

  return (
    <section className="space-y-4">
      {/* Import / export the whole config as a portable JSON file. Sits above the groups so it's
          discoverable, and runs through the same `run` mutation as Save (fork-on-launch + resync). */}
      <ConfigImportExport
        questionnaireId={questionnaireId}
        versionId={versionId}
        config={config}
        run={run}
        busy={busy}
      />

      {!config.saved && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="font-medium">Not yet saved.</span>
          <span>Save this configuration at least once before the version can be launched.</span>
        </div>
      )}

      {/* Two-column on wide screens: a sticky scroll-spy rail (wayfinding only — nothing moves)
          beside the single settings scroll. The rail discovers its items from the
          `[data-section-rail]` cards inside `#settings-sections`. Content is pinned to column 2
          so the layout doesn't shift when the rail mounts (the rail renders null pre-hydration). */}
      <div className="lg:grid lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start lg:gap-6">
        <SectionRail
          targetId="settings-sections"
          ariaLabel="Settings sections"
          className="top-24 hidden self-start lg:sticky lg:block"
        />

        <div id="settings-sections" className="min-w-0 space-y-4 lg:col-start-2">
          {/* Live conflict summary — contradictory / no-op setting combinations, each linking to its
              section. Renders nothing when the config is coherent. */}
          <ConfigConflictBanner conflicts={conflicts} />

          {/* ── 1. Questions & completion — the core run loop: how questions are chosen and when a
             session is allowed to finish. Most-used knobs, so they lead. ── */}
          <SettingsGroup
            icon={ListChecks}
            accent="bg-blue-500/10 text-blue-600 dark:text-blue-400"
            id="questions"
            title="Questions & completion"
            description="How the agent chooses the next question and when a session is allowed to finish."
            conflicts={conflictsFor('questions')}
          >
            <div className="space-y-1.5 sm:max-w-sm">
              <Label className="text-sm font-medium">
                Selection strategy{' '}
                <FieldHelp title="Selection strategy">
                  How the agent picks the next question — in order, by question weight, or
                  adaptively chosen from the conversation so far.
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
                  {SELECTION_STRATEGY_ORDER.map((s) => (
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
                    A session can&apos;t complete until at least this many questions have been
                    answered. 0 means no minimum.
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
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  Answer confidence floor{' '}
                  <FieldHelp title="Answer confidence floor">
                    How sure the agent must be before a background-filled answer counts as
                    confirmed. To take the hassle out of form-filling, the agent fills questions
                    opportunistically — on a good hunch from what the respondent said — and marks
                    those guesses <em>tentative</em>. A tentative answer below this confidence does
                    NOT count toward completion or satisfy a required question until the respondent
                    corroborates it (each confirmation strengthens it). Lower = accept guesses
                    sooner (faster, less checking); higher = insist on firmer confirmation before
                    the form is &ldquo;done&rdquo;. <code className="text-xs">0.5</code> gates the
                    agent&rsquo;s opportunistic guesses without holding back genuine answers; raise
                    toward <code className="text-xs">0.65</code>+ to demand firmer confirmation.
                  </FieldHelp>
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={answerConfidenceFloor}
                  onChange={(e) => setAnswerConfidenceFloor(e.target.value)}
                  disabled={busy}
                />
              </div>
            </div>
            <div className="space-y-1.5 sm:max-w-xs">
              <Label className="text-sm font-medium">
                Data-slot attempts{' '}
                <FieldHelp title="Data-slot attempts">
                  How many times the agent probes one data slot (topic) before it records its best
                  guess and moves on — so a respondent never gets stuck being asked the same thing.{' '}
                  <code className="text-xs">2</code> = ask once, then one sharper re-ask. This is
                  the ceiling on how hard a <em>shaky</em> answer is deepened: a terse, vague, or
                  only-inferred answer (low confidence) is the kind the agent circles back on, and a
                  higher value lets it probe such answers further at the cost of a longer
                  conversation. The best guess is shown as &ldquo;provisional · may revisit&rdquo;
                  and can still be refined later. Only applies in data-slot mode.
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
            {/* Respondent-controlled early finish — lets a person voluntarily end and get their report
            once they've crossed a minimum bar, distinct from the agent's own completion thresholds
            above. The two minimums are OR'd; either at 0 means "not a criterion". */}
            <div className="flex items-center gap-2">
              <Switch
                checked={allowEarlyFinish}
                onCheckedChange={setAllowEarlyFinish}
                disabled={busy}
              />
              <Label className="text-sm font-medium">
                Let respondents finish early{' '}
                <FieldHelp title="Let respondents finish early">
                  Adds a calm &ldquo;Continue or finish up&rdquo; control to the respondent&rsquo;s
                  screen once they&rsquo;ve answered enough. Choosing &ldquo;Finish up&rdquo; ends
                  the session and prepares their report — even if the agent&rsquo;s own completion
                  thresholds above aren&rsquo;t met, and{' '}
                  <em>even if required questions are still open</em> (this is a deliberate escape
                  hatch). The control unlocks once <em>either</em> minimum below is reached.
                </FieldHelp>
              </Label>
            </div>
            {allowEarlyFinish && (
              <div className="space-y-3">
                {/* The two bars are OR'd with no priority — whichever the respondent reaches first
                    unlocks the control. Stated up-front because the priority wasn't obvious. */}
                <p className="text-muted-foreground text-xs leading-relaxed">
                  The button appears as soon as the respondent crosses <strong>either</strong> bar
                  below — whichever comes first (they have equal priority). Set a bar to{' '}
                  <code className="text-xs">0</code> / <code className="text-xs">Off</code> to
                  ignore that axis. The default (100% coverage, questions off) shows the button only
                  once they&rsquo;ve effectively completed the questionnaire; lower the coverage to
                  let them finish sooner.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-sm font-medium">
                      Finish-up min % complete{' '}
                      <FieldHelp title="Finish-up minimum % complete">
                        The weighted completion the respondent must reach before the &ldquo;Finish
                        up&rdquo; control appears, as a percentage.{' '}
                        <code className="text-xs">100</code> = only once effectively complete (the
                        default); <code className="text-xs">50</code> = halfway;{' '}
                        <code className="text-xs">0</code> = no coverage requirement on this axis.
                        OR&rsquo;d with the question minimum — whichever the respondent reaches
                        first unlocks. Both bars at 0 ⇒ available from the start.
                      </FieldHelp>
                    </Label>
                    <div className="relative">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={5}
                        value={earlyFinishMinCoveragePct}
                        onChange={(e) => setEarlyFinishMinCoveragePct(e.target.value)}
                        disabled={busy}
                        className="pr-8"
                      />
                      <span className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm">
                        %
                      </span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm font-medium">
                      Finish-up min questions{' '}
                      <FieldHelp title="Finish-up minimum questions">
                        Number of answered questions before the &ldquo;Finish up&rdquo; control
                        appears. <code className="text-xs">0</code> = <strong>Off</strong> — no
                        question-count requirement on this axis (the default; the % bar gates
                        instead). OR&rsquo;d with the coverage minimum — whichever comes first
                        unlocks.
                      </FieldHelp>
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      placeholder="Off"
                      value={earlyFinishMinQuestions}
                      onChange={(e) => setEarlyFinishMinQuestions(e.target.value)}
                      disabled={busy}
                    />
                  </div>
                </div>
              </div>
            )}
            {/* Adaptive data-slot selection ranks unfilled slots by embedding similarity, so it needs
            the data slots embedded — the data-slot analogue of the question-embeddings step under
            Selection strategy. The step itself handles the no-slots-yet empty state. */}
            <DataSlotEmbeddingStep
              questionnaireId={questionnaireId}
              versionId={versionId}
              busy={busy}
            />
          </SettingsGroup>

          {/* ── 2. Respondent experience — how a person actually completes it (format, input, what
             they see, whether they're identified). ── */}
          <SettingsGroup
            icon={MessageSquareText}
            accent="bg-violet-500/10 text-violet-600 dark:text-violet-400"
            id="experience"
            title="Respondent experience"
            description="How a respondent completes the questionnaire — format, input, and what they see alongside the chat."
            conflicts={conflictsFor('experience')}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  Presentation mode{' '}
                  <FieldHelp title="Presentation mode">
                    How the respondent completes this questionnaire. Chat is the streaming
                    conversation. Form presents the questions as a raw, sectioned form with the
                    right input per type (likert, choices, yes/no, text…). Both offers a chat ↔ form
                    toggle so the respondent can navigate sections, see what&apos;s already
                    answered, and edit answers the agent inferred — a useful escape hatch when the
                    chat struggles. Form mode is question-based: for questionnaires using data
                    slots, editing a question reconciles into the chat on the next turn.
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
                    How much of the questionnaire the live answer panel shows the respondent beside
                    the chat. Full progress lists every question grouped by section with an
                    answered-count; answered only shows just the answers captured so far.
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
              <Switch
                checked={inlineCorrectionEnabled}
                onCheckedChange={setInlineCorrectionEnabled}
                disabled={busy}
              />
              <Label className="text-sm font-medium">
                Inline answer correction{' '}
                <FieldHelp title="Inline answer correction">
                  Let respondents fix an answer the latest turn just captured with a small inline
                  editor — beneath the most-recent message in the chat and on the answer-panel rows
                  — instead of re-explaining in a new message. Corrections save directly (the same
                  path as the form view), so they don&apos;t spend a turn or trip a contradiction
                  notice. On by default.
                </FieldHelp>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={sessionResumeEnabled}
                onCheckedChange={setSessionResumeEnabled}
                disabled={busy}
              />
              <Label className="text-sm font-medium">
                Resume in-progress sessions{' '}
                <FieldHelp title="Resume in-progress sessions">
                  Let a respondent return to a session they already started instead of always
                  beginning again. The no-login link remembers the session on that device, so
                  reopening it shows a &ldquo;Continue where you left off / Start new&rdquo; choice
                  (quoting the session&apos;s reference code), and a respondent can also resume from
                  another device by entering that code. On by default. When off, returning always
                  starts a fresh session. Note: on a shared or kiosk device the next person could
                  see and continue the previous session within its 24-hour window — turn this off
                  for shared devices.
                </FieldHelp>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={voiceEnabled} onCheckedChange={setVoiceEnabled} disabled={busy} />
              <Label className="text-sm font-medium">
                Voice input{' '}
                <FieldHelp title="Voice input">
                  Let respondents answer by voice as well as text — shows a mic button in the
                  composer and tells them they can talk through their answers. When off, the mic is
                  hidden and the agent never suggests it. Also requires the platform voice-input
                  flag.
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
                  Let respondents attach files (images, documents) to their answers — shows a
                  paperclip button in the composer. When off, the button is hidden and any
                  attachments sent anyway are ignored. Also requires the platform attachment-input
                  flag.
                </FieldHelp>
              </Label>
            </div>
          </SettingsGroup>

          {/* ── 2a-intro. Respondent intro / splash — an admin opt-in cover screen shown before the
             questionnaire starts. The "how it works / what you'll get" copy is derived at runtime
             from the presentation mode + respondent-report settings — only the background and button
             label are authored here. ── */}
          <SettingsGroup
            icon={PanelTop}
            accent="bg-sky-500/10 text-sky-600 dark:text-sky-400"
            id="intro"
            title="Intro screen"
            description="An optional cover screen shown before the questionnaire starts — it introduces the process and what the respondent gets at the end (both adapt automatically to the settings above), plus an admin-authored background section."
          >
            <div className="flex items-center gap-2">
              <Switch
                checked={intro.enabled}
                onCheckedChange={(enabled) => setIntro((i) => ({ ...i, enabled }))}
                disabled={busy}
              />
              <Label className="text-sm font-medium">
                Show the intro screen{' '}
                <FieldHelp title="Intro screen">
                  When on, respondents see a short welcome screen before the questionnaire begins,
                  explaining how it works (this adapts to the presentation mode) and what
                  they&apos;ll receive at the end (this adapts to the Respondent Report settings).
                  They press a button to start — no question is asked until they do. Off by default,
                  so existing questionnaires are unchanged.
                </FieldHelp>
              </Label>
            </div>
            {intro.enabled && (
              <div className="border-border/60 ml-1 space-y-4 border-l pl-4">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">
                    Background{' '}
                    <FieldHelp title="About this questionnaire">
                      An optional section shown on the intro screen, in your own words — what this
                      questionnaire is about, who&apos;s running it, its purpose, and how the
                      results will be used. Markdown is supported (headings, bold, lists, links).
                      Leave blank to show just the standard guidance. A cohort can override this
                      with its own text.
                    </FieldHelp>
                  </Label>
                  <IntroBackgroundField
                    value={intro.background}
                    onChange={(v) => setIntro((i) => ({ ...i, background: v }))}
                    disabled={busy}
                    questionnaireId={questionnaireId}
                    versionId={versionId}
                    placeholder="Tell respondents what this questionnaire is about, who's running it, and how results are used — or upload a document / generate it with AI."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">
                    Intro video{' '}
                    <FieldHelp title="Intro video">
                      An optional YouTube or Vimeo link shown alongside the about text on the intro
                      screen — a welcome from the team, or a short explainer. Paste the normal share
                      link (e.g. <code>https://youtu.be/…</code> or <code>https://vimeo.com/…</code>
                      ); it&apos;s embedded as a privacy-enhanced player. Leave blank for no video.
                    </FieldHelp>
                  </Label>
                  <Input
                    type="url"
                    inputMode="url"
                    value={intro.videoUrl}
                    onChange={(e) => setIntro((i) => ({ ...i, videoUrl: e.target.value }))}
                    maxLength={INTRO_VIDEO_URL_MAX_LENGTH}
                    placeholder="https://youtu.be/dQw4w9WgXcQ"
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5 sm:max-w-xs">
                  <Label className="text-sm font-medium">
                    Button label{' '}
                    <FieldHelp title="Button label">
                      The text on the button that starts the questionnaire. Leave blank for a
                      sensible default that matches the presentation mode (e.g. “Start the
                      conversation”).
                    </FieldHelp>
                  </Label>
                  <Input
                    value={intro.buttonLabel}
                    onChange={(e) => setIntro((i) => ({ ...i, buttonLabel: e.target.value }))}
                    maxLength={INTRO_BUTTON_LABEL_MAX_LENGTH}
                    placeholder="Start the conversation"
                    disabled={busy}
                  />
                </div>
              </div>
            )}
          </SettingsGroup>

          {/* ── 2b. Reasoning stream — the live "watch it think" demo feature. Sits with the respondent
             experience (it's a respondent-facing surface) but in its own group so the marquee toggle
             and its placement/persistence options are discoverable. ── */}
          <SettingsGroup
            icon={Brain}
            accent="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
            id="reasoning"
            title="Reasoning stream"
            description="Show a per-turn “watch it think” trace in the chat — answers captured, contradictions spotted, and why the next question was chosen. Also requires the platform reasoning-stream flag."
            conflicts={conflictsFor('reasoning')}
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
                  When on, the respondent sees the agent&apos;s per-turn reasoning as it works —
                  answers it captured (and how confident it is), any contradictions it noticed, and
                  why it&apos;s asking the next question. It&apos;s derived from work the
                  conversation already does, so it adds no extra cost or latency. A great demo
                  moment; turn it off for a plainer experience. Also requires the platform
                  reasoning-stream flag to be on.
                </FieldHelp>
              </Label>
            </div>
            {reasoningStreamEnabled && (
              <div className="border-border/60 ml-1 space-y-4 border-l pl-4">
                <div className="space-y-1.5 sm:max-w-sm">
                  <Label className="text-sm font-medium">
                    Placement{' '}
                    <FieldHelp title="Reasoning stream placement">
                      How the reasoning reveals on each turn. <strong>Animated</strong> opens the
                      newest turn&apos;s reasoning automatically, holds it for two seconds, then
                      animates it closed to a small “reasoning” chip — and the next question only
                      starts typing once it has tucked away, so the respondent reads the reasoning
                      first. Eye-catching for a live demo. <strong>Inline</strong> is quieter: the
                      chip stays closed until the respondent clicks to expand it.
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
                {/* Animated-only timing: the dwell scales with how many reasoning steps the turn has. */}
                {reasoningStreamPlacement === 'overlay' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">
                        Reasoning dwell (ms){' '}
                        <FieldHelp title="Reasoning dwell">
                          How long the reasoning summary stays open before it tucks away, for a
                          trace of up to two steps. The next question starts typing only after it
                          closes. Default 2000 (2s).
                        </FieldHelp>
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={10000}
                        step={100}
                        aria-label="Reasoning dwell in milliseconds"
                        value={reasoningStreamDwellMs}
                        onChange={(e) => setReasoningStreamDwellMs(e.target.value)}
                        disabled={busy}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">
                        Extra per item (ms){' '}
                        <FieldHelp title="Extra dwell per reasoning step">
                          Added to the dwell for each reasoning step beyond the second, so a longer
                          summary stays open long enough to read. Total ={' '}
                          <code>dwell + max(0, steps − 2) × this</code>. Default 750.
                        </FieldHelp>
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        max={5000}
                        step={10}
                        aria-label="Extra dwell per reasoning step in milliseconds"
                        value={reasoningStreamPerItemMs}
                        onChange={(e) => setReasoningStreamPerItemMs(e.target.value)}
                        disabled={busy}
                      />
                    </div>
                  </div>
                )}
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
                      off, it shows only on the turn as it happens; resumed or earlier turns show
                      nothing.
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
            id="preview-tools"
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
                  <strong>Inspector</strong> drawer. For each turn it shows the sequence of agent
                  calls the conversation made, and for each call the model used, response time,
                  estimated cost, token counts, and the raw prompt and response. It appears{' '}
                  <strong>only</strong> in a preview session — a real respondent never sees it and
                  the data is never sent to them. Useful for understanding and debugging how the
                  conversation is being driven.
                </FieldHelp>
              </Label>
            </div>
          </SettingsGroup>

          {/* ── 2c. Interviewer voice — an either/or: EITHER a hand-tuned custom tone & persona, OR a
             built-in library persona. The two are mutually exclusive — the mode toggle flips
             `personaSelection.enabled` and only the chosen mode's editor renders, so an admin can
             never configure both at once (the built-in persona would silently win at runtime). ── */}
          <SettingsGroup
            icon={SlidersHorizontal}
            accent="bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400"
            id="tone"
            title="Interviewer tone & persona"
            description="How the conversational interviewer sounds. Choose one — hand-tune a custom voice (a persona plus tone dials), or use one of the built-in personas. They’re mutually exclusive."
            conflicts={conflictsFor('tone')}
          >
            <VoiceModeToggle
              mode={personaSelection.enabled ? 'persona' : 'custom'}
              onChange={(mode) => setPersonaSelectionPatch({ enabled: mode === 'persona' })}
              disabled={busy}
            />

            {personaSelection.enabled ? (
              <PersonaLibraryPanel
                personas={BUILT_IN_PERSONAS}
                selection={personaSelection}
                busy={busy}
                onSelectionChange={setPersonaSelectionPatch}
              />
            ) : (
              <>
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
                        <p>
                          Cast the interviewer in a role and it will speak from that perspective —
                          for example “You are an experienced, supportive career coach” or “You are
                          a concise management consultant.” Free text; keep it a sentence or two.
                          The tone sliders below still apply on top of the persona.
                        </p>
                        <p className="mt-2">
                          When on, your text is wrapped in a leading clause and added to the
                          interviewer’s prompt (via{' '}
                          <code className="text-xs">buildToneInstructions</code>):{' '}
                          <span className="italic">
                            “Adopt this persona throughout — let it shape your voice and the
                            perspective you bring: …”
                          </span>{' '}
                          The exact clause is shown beneath the box.
                        </p>
                      </FieldHelp>
                    </Label>
                  </div>
                  {tone.persona.enabled && (
                    <div className="border-border/60 ml-1 space-y-1.5 border-l pl-4">
                      <Textarea
                        value={tone.persona.text}
                        onChange={(e) => setTonePersona({ text: e.target.value })}
                        maxLength={TONE_PERSONA_MAX_LENGTH}
                        rows={2}
                        disabled={busy}
                        placeholder="e.g. You are an experienced, supportive career coach."
                        className="max-w-md"
                      />
                      {/* Live "what's added" preview — the precise persona clause the prompt receives. */}
                      <p className="text-muted-foreground max-w-md text-xs leading-relaxed">
                        {tone.persona.text.trim() ? (
                          <>
                            <span className="font-medium">Adds to the prompt:</span>{' '}
                            <span className="text-foreground/80 italic">
                              “{personaToneClause(tone.persona.text)}”
                            </span>
                          </>
                        ) : (
                          'Enter persona text above to see the exact clause it adds.'
                        )}
                      </p>
                    </div>
                  )}
                </div>

                {/* Scale legend — explains the signed −2…+2 dials and the balanced-vs-intensity split
                    (the same distinction each row's help + live preview reflect per dial). */}
                <div className="bg-muted/30 text-muted-foreground rounded-md border p-3 text-xs leading-relaxed">
                  Each dial runs from <strong className="text-foreground">−2 to +2</strong> with{' '}
                  <strong className="text-foreground">0</strong> in the middle.{' '}
                  <strong className="text-foreground">Balanced</strong> dials (empathy, formality,
                  verbosity, reading complexity, humour) treat 0 as neutral — it adds nothing —
                  while − and + push toward the two opposite styles shown under each slider.{' '}
                  <strong className="text-foreground">Intensity</strong> dials (mirroring, mimicry,
                  warmth, curiosity) run low → high, so every position adds a clause; switch the
                  dial off for none. The exact clause each position injects is shown live beneath
                  its slider.
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
              </>
            )}
          </SettingsGroup>

          {/* ── Interviewer strategy — overrides the default questioning approach when enabled. ── */}
          <SettingsGroup
            icon={Compass}
            accent="bg-sky-500/10 text-sky-600 dark:text-sky-400"
            id="interviewer-strategy"
            title="Interviewer strategy"
            description="How the interviewer decides what to ask each turn. Off keeps the built-in default — ask the one provided question, one thing at a time, phrased as an open invitation. On adds an approach + tactics that override that default in the interviewer's prompt."
          >
            <div className="flex items-center gap-2">
              <Switch
                checked={interviewerStrategy.enabled}
                onCheckedChange={(enabled) => setStrategy({ enabled })}
                disabled={busy}
              />
              <Label className="text-sm font-medium">
                Override the default questioning approach{' '}
                <FieldHelp title="Interviewer strategy">
                  <p>
                    By default the interviewer prompt tells it to{' '}
                    <strong>ask the one provided question, one thing at a time</strong>, phrased as
                    an open invitation (“Tell me about…”), in a neutral register.
                  </p>
                  <p className="mt-2">
                    When on, an <code className="text-xs">&lt;interviewer_strategy&gt;</code> block
                    is appended to the prompt <em>after</em> those default rules — so it takes
                    precedence — carrying the approach and tactics below. When off, that block is
                    omitted entirely and nothing about the default changes.
                  </p>
                </FieldHelp>
              </Label>
            </div>

            {interviewerStrategy.enabled && (
              <div className="border-border/60 ml-1 space-y-4 border-l pl-4">
                <div className="space-y-1.5 sm:max-w-xs">
                  <Label className="text-sm font-medium">
                    Approach{' '}
                    <FieldHelp title="Approach">
                      <p>
                        The questioning-approach clause added to the prompt. It sets how open vs.
                        targeted each ask is:
                      </p>
                      <ul className="mt-2 list-disc space-y-2 pl-4">
                        <li>
                          <strong>Funnel (open → targeted)</strong> — a coverage-driven arc. While
                          little is covered it <em>overrides</em> the “ask the one question / one
                          thing at a time” rules and asks a broad opener about the topic{' '}
                          <em>area</em> (“Tell me about…”), so one wide answer can fill several
                          gaps; the first couple of asks get an extra permission-giving opening. As
                          coverage builds it steers toward the specific points still missing, then
                          near the end asks one concrete question at a time. Terse answers move it
                          toward targeted a step sooner.
                        </li>
                        <li>
                          <strong>Open throughout</strong> — the broad opener above, the whole way;
                          keeps overriding “one question / one thing at a time” so it stays
                          exploratory. Best for rich, qualitative discovery.
                        </li>
                        <li>
                          <strong>Targeted / efficient</strong> — one specific, concrete question at
                          a time with minimal preamble, favouring a direct answerable ask over a
                          broad invitation. Best for factual questionnaires and fastest completion.
                        </li>
                      </ul>
                    </FieldHelp>
                  </Label>
                  <Select
                    value={interviewerStrategy.approach}
                    onValueChange={(v) => setStrategy({ approach: v as InterviewerApproach })}
                    disabled={busy}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {INTERVIEWER_APPROACHES.map((a) => (
                        <SelectItem key={a} value={a}>
                          {INTERVIEWER_APPROACH_LABELS[a]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={interviewerStrategy.probeDepth}
                      onCheckedChange={(probeDepth) => setStrategy({ probeDepth })}
                      disabled={busy}
                    />
                    <Label className="text-sm font-medium">
                      Probe for depth{' '}
                      <FieldHelp title="Probe for depth">
                        Adds a <strong>PROBE FOR DEPTH</strong> clause on top of the approach: if
                        the last answer was shallow or vague, ask ONE brief follow-up (“What makes
                        you say that?”, “Can you give an example?”) before moving on to anything
                        new. Deepens qualitative answers at the cost of a few more turns. Combines
                        with any approach.
                      </FieldHelp>
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={interviewerStrategy.reflect}
                      onCheckedChange={(reflect) => setStrategy({ reflect })}
                      disabled={busy}
                    />
                    <Label className="text-sm font-medium">
                      Reflect &amp; confirm{' '}
                      <FieldHelp title="Reflect & confirm">
                        Adds a <strong>REFLECT AND CONFIRM</strong> clause: before the next
                        question, briefly play back the gist of the last answer in one short clause
                        (“So it sounds like… — is that right?”) so they can confirm or correct it —
                        not a verbatim repeat. Builds trust and strengthens answer confidence
                        through corroboration.
                      </FieldHelp>
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={interviewerStrategy.batchRelated}
                      onCheckedChange={(batchRelated) => setStrategy({ batchRelated })}
                      disabled={busy}
                    />
                    <Label className="text-sm font-medium">
                      Batch related questions{' '}
                      <FieldHelp title="Batch related questions">
                        Adds a <strong>BATCH RELATED</strong> clause: when several remaining gaps
                        are closely related, the interviewer MAY invite two or three together in one
                        natural question — the one allowed exception to the default “one thing at a
                        time” rule. Faster and more conversational; slightly harder to extract
                        cleanly.
                      </FieldHelp>
                    </Label>
                  </div>
                </div>
              </div>
            )}
          </SettingsGroup>

          {/* ── 3. Access & invitations — who may start, and the invitee detail fields captured. ── */}
          <SettingsGroup
            icon={Mail}
            accent="bg-amber-500/10 text-amber-600 dark:text-amber-400"
            id="access"
            title="Access & invitations"
            description="Who may start this questionnaire, the identity (anonymous) axis, and which invitee details the Invitations tab captures."
            conflicts={conflictsFor('access')}
          >
            {/* Identity axis — lives here (with Access) so it's findable, though it's independent of
                the access mode: an anonymous questionnaire can still be invitation-only, and a named
                one can still be public. */}
            <div className="bg-muted/20 flex items-start gap-3 rounded-lg border p-3">
              <Switch
                checked={anonymousMode}
                onCheckedChange={setAnonymousMode}
                disabled={busy}
                className="mt-0.5"
              />
              <Label className="text-sm font-medium">
                Anonymous mode{' '}
                <FieldHelp title="Anonymous mode">
                  Don&apos;t collect identifying profile fields — responses aren&apos;t tied to a
                  named individual. This is the <em>identity</em> axis, independent of{' '}
                  <em>Access</em> (who may start): an anonymous questionnaire can still be
                  invitation-only, and a named one can still be public. When anonymous, invitees are
                  tracked only as started/completed — never linked to their answers, and{' '}
                  <strong>respondent profile fields are not collected</strong>.
                </FieldHelp>
              </Label>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                Access mode{' '}
                <FieldHelp title="Access mode">
                  Who may start a session. Invitation only: a per-invitee link is required. Public
                  link: anyone with the URL can answer. Both: either works. This is the{' '}
                  <em>access</em> axis — separate from Anonymous mode (whether identity is
                  collected).
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
              {/* The collective no-login link — only meaningful when a direct (no-invitation)
              start is allowed. Follows the live selection so it appears/disappears as you change
              the mode. Per-invitee links live on the Invitations tab. */}
              {accessMode !== 'invitation_only' && (
                <div className="pt-1">
                  <PublicRespondentLink versionId={versionId} isLaunched={isVersionLaunched} />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">
                Invitee details{' '}
                <FieldHelp title="Invitee details">
                  Which fields the Invitations tab captures per person (and which are required).
                  Email is always collected. Shown fields appear as columns in the import/verify
                  grid; required fields must be filled before sending.
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
            id="safeguarding"
            title="Answer quality & safeguarding"
            description="Protective and data-integrity features: handling sensitive disclosures, ending abusive sessions, and catching contradictions. Each also requires its platform flag."
            conflicts={conflictsFor('safeguarding')}
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
                    phrases every later question. Best-effort awareness, not a guaranteed
                    safeguarding net. Requires the platform sensitivity-awareness flag to be on.
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
                        support is available — you can reach our team or a helpline at any
                        time.&rdquo;
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
                  How many non-genuine answers (preposterous, abusive, or off-topic) a respondent
                  may give before the session is automatically ended. Earlier strikes get escalating
                  warnings and the answer is set aside; the Nth ends the session. Colloquial or lazy
                  answers are tolerated. Set to <code className="text-xs">0</code> to turn the gate
                  off. Requires the platform seriousness-gate flag to be on.
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
                    Whether the agent watches for answers that contradict earlier ones — off, flag
                    them, or probe with a follow-up.
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
                        How many prior answers to check each new answer against. Must be at least 1
                        when detection is on.
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
                        respondent turns. 1 runs it every turn (most thorough); a higher value
                        trades some immediacy for lower per-turn cost. The completion sweep always
                        runs regardless.
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
                    A second, focused pass that maps a free-form answer onto a choice or scale
                    option the first pass couldn&apos;t place — e.g. &ldquo;Marketing&rdquo; to the
                    &ldquo;Other&rdquo; option, or &ldquo;10 years&rdquo; to the &ldquo;3+
                    years&rdquo; band. <strong>Fallback</strong> runs it only when a clearly-given
                    answer didn&apos;t map (no extra cost otherwise). <strong>Always</strong> also
                    tries to fill any still-open choice/scale question each turn (more thorough, one
                    extra model call per answered turn). <strong>Off</strong> disables it.
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
                    slot, already-filled slots, same-theme slots, mapped questions, and the most
                    similar to what the respondent just said — cutting per-turn prompt cost on big
                    questionnaires. Spends one embedding call per turn and is fail-soft (any
                    embedding error falls back to the full candidate set).{' '}
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
            id="budget"
            title="Budget & limits"
            description="Cost control and hard caps on a single session, with a pre-launch spend estimate."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  Cost budget (USD / session){' '}
                  <FieldHelp title="Cost budget">
                    Optional per-session spend cap in US dollars. Leave blank for no cap.
                    (Enforcement lands with the turn engine; the estimate below shows projected
                    spend against this cap.)
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
                    Hard limit on how many questions a single session will ask. Leave blank for no
                    cap.
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

          {/* ── 5. Respondent profile fields — what to collect from the respondent, and how.
             Last: optional, set-up-once metadata rather than run-time behaviour. ── */}
          <SettingsGroup
            icon={ClipboardList}
            accent="bg-slate-500/10 text-slate-600 dark:text-slate-300"
            id="profile-fields"
            title="Respondent profile fields"
            description="Ask respondents for a name, email, or other details — on a short form or during the conversation. Off by default; never collected on an anonymous questionnaire."
            conflicts={conflictsFor('profile-fields')}
            headerAction={
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium select-none">
                <span className={captureEnabled ? 'text-foreground' : 'text-muted-foreground'}>
                  {captureEnabled ? 'On' : 'Off'}
                </span>
                <Switch
                  checked={captureEnabled}
                  onCheckedChange={toggleCaptureEnabled}
                  disabled={busy}
                  aria-label="Collect respondent profile fields"
                />
              </label>
            }
          >
            {!captureEnabled ? (
              /* Off state — the default. A calm panel that says what turning it on does. */
              <div className="bg-muted/20 border-border/70 rounded-xl border border-dashed px-6 py-8 text-center">
                <div className="bg-muted text-muted-foreground/70 mx-auto flex h-11 w-11 items-center justify-center rounded-full">
                  <ClipboardList className="h-5 w-5" aria-hidden />
                </div>
                <p className="text-foreground mt-3 text-sm font-medium">
                  Not collecting respondent details
                </p>
                <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-xs">
                  Respondents go straight into the conversation. Turn this on to ask for a name,
                  email, and anything else — on a short form before the chat, or naturally during
                  it.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => toggleCaptureEnabled(true)}
                  disabled={busy}
                >
                  <Plus className="mr-1 h-4 w-4" /> Turn on &amp; add starter fields
                </Button>
              </div>
            ) : (
              <>
                {/* Default placement — the version-wide default for where fields are collected, shown
                    as a segmented control so both options are visible at once. Each field can override
                    it below (a hybrid questionnaire). Ignored when the version is anonymous. */}
                <div className="mb-6 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-foreground text-sm font-medium">
                      Where are answers collected by default?
                    </Label>
                    <FieldHelp title="Default placement">
                      The default for the fields below. <strong>Form</strong> shows a short form
                      after the intro and before the conversation — the respondent can&apos;t start
                      until it&apos;s filled in. <strong>Conversation</strong> drops the form and
                      has the interviewer ask for these naturally in the chat. Any field can
                      override this with its own &quot;Collect via&quot; setting — e.g. keep name
                      &amp; email on the form while the rest are gathered in conversation (a hybrid
                      questionnaire).
                    </FieldHelp>
                  </div>
                  <Segmented
                    ariaLabel="Default placement"
                    value={captureMode}
                    onChange={(v) => setCaptureMode(v)}
                    disabled={busy}
                    options={CAPTURE_MODES.map((m) => ({
                      value: m,
                      label: CAPTURE_MODE_SHORT_LABELS[m],
                      icon: CAPTURE_MODE_ICONS[m],
                    }))}
                  />
                  <p className="text-muted-foreground text-xs">
                    {captureMode === 'form'
                      ? 'Respondents fill a short form before the conversation starts.'
                      : 'The interviewer asks for these naturally during the conversation.'}{' '}
                    Each field can override this below.
                  </p>
                </div>

                {profileFields.length === 0 ? (
                  <div className="border-border/70 bg-muted/10 rounded-xl border border-dashed px-6 py-6 text-center">
                    <p className="text-foreground text-sm font-medium">No fields yet</p>
                    <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-xs">
                      Add a field to collect a name, email, or anything else you need alongside
                      their answers.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {profileFields.length > 1 && (
                      <div className="flex items-center justify-between">
                        <p className="text-muted-foreground text-xs">
                          {profileFields.length} fields
                        </p>
                        {profileFields.some((f) => f.expanded) && (
                          <button
                            type="button"
                            onClick={collapseAllFields}
                            className="text-muted-foreground hover:text-foreground text-xs font-medium"
                          >
                            Collapse
                          </button>
                        )}
                      </div>
                    )}
                    {profileFields.map((field, index) => {
                      const FieldIcon = PROFILE_FIELD_TYPE_ICONS[field.type];
                      const fieldName = field.label.trim() || `Field ${index + 1}`;
                      return (
                        <div
                          key={index}
                          className="bg-card overflow-hidden rounded-xl border shadow-sm"
                        >
                          {/* Summary row — always visible; click to expand/collapse the editor. */}
                          <div className="flex items-center gap-2 p-3">
                            <button
                              type="button"
                              onClick={() => toggleFieldExpanded(index)}
                              aria-expanded={field.expanded}
                              aria-label={`Toggle ${fieldName}`}
                              disabled={busy}
                              className="flex min-w-0 flex-1 items-center gap-3 text-left"
                            >
                              <ChevronRight
                                className={cn(
                                  'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
                                  field.expanded && 'rotate-90'
                                )}
                                aria-hidden
                              />
                              <span className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                                <FieldIcon className="h-4 w-4" aria-hidden />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="text-foreground block truncate text-sm font-medium">
                                  {fieldName}
                                </span>
                                {!field.expanded && (
                                  <span className="text-muted-foreground block truncate text-xs">
                                    {describeProfileField(field, captureMode)}
                                  </span>
                                )}
                              </span>
                              {!field.expanded && (
                                <span
                                  className={cn(
                                    'shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-medium',
                                    field.required
                                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                                      : 'bg-muted text-muted-foreground'
                                  )}
                                >
                                  {field.required ? 'Required' : 'Optional'}
                                </span>
                              )}
                            </button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeField(index)}
                              disabled={busy}
                              aria-label={`Remove ${fieldName}`}
                              className="text-muted-foreground hover:text-destructive shrink-0"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>

                          {field.expanded && (
                            <div className="border-t">
                              <div className="space-y-3 p-4">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                                  <div className="flex-1 space-y-1">
                                    <Label className="text-xs">What to ask the respondent</Label>
                                    <Input
                                      value={field.label}
                                      placeholder="e.g. Your organisation"
                                      onChange={(e) => updateFieldLabel(index, e.target.value)}
                                      disabled={busy}
                                    />
                                  </div>
                                  <div className="space-y-1 sm:w-44">
                                    <Label className="text-xs">Answer type</Label>
                                    <Select
                                      value={field.type}
                                      onValueChange={(v) =>
                                        updateField(index, { type: v as ProfileFieldType })
                                      }
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
                                </div>

                                {field.type === 'select' && (
                                  <div className="space-y-1">
                                    <Label className="text-xs">
                                      Choices{' '}
                                      <FieldHelp title="Select choices">
                                        Comma-separated list of options the respondent picks from.
                                      </FieldHelp>
                                    </Label>
                                    <Input
                                      value={field.optionsText}
                                      placeholder="e.g. Engineering, Sales, Support"
                                      onChange={(e) =>
                                        updateField(index, { optionsText: e.target.value })
                                      }
                                      disabled={busy}
                                    />
                                  </div>
                                )}

                                <label className="inline-flex cursor-pointer items-center gap-2 text-sm select-none">
                                  <Switch
                                    checked={field.required}
                                    onCheckedChange={(checked) =>
                                      updateField(index, { required: checked })
                                    }
                                    disabled={busy}
                                  />
                                  <span className="font-medium">Required</span>
                                  <span className="text-muted-foreground text-xs">
                                    {field.required ? 'must be answered' : 'optional'}
                                  </span>
                                </label>
                              </div>

                              {/* Advanced strip: placement override, checking, and the auto-derived storage key. */}
                              <div className="bg-muted/30 space-y-3 border-t px-4 py-3">
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                                  <div className="flex items-center gap-1.5">
                                    <Label className="text-xs">Collect via</Label>
                                    <FieldHelp title="Collect via">
                                      Where THIS field is collected. <strong>Default</strong>{' '}
                                      follows the version default above. Override it to mix the two
                                      — e.g. keep name &amp; email on the form while the rest are
                                      gathered in conversation. Conversation fields are asked for
                                      naturally in-chat and saved as the respondent provides them;
                                      required ones keep being asked until answered.
                                    </FieldHelp>
                                  </div>
                                  <Segmented
                                    size="sm"
                                    ariaLabel={`Collect ${fieldName} via`}
                                    value={field.captureVia ?? '__default__'}
                                    onChange={(v) =>
                                      updateField(index, {
                                        captureVia: v === '__default__' ? undefined : v,
                                      })
                                    }
                                    disabled={busy}
                                    options={[
                                      {
                                        value: '__default__',
                                        label: 'Default',
                                        hint: `(${CAPTURE_MODE_SHORT_LABELS[captureMode]})`,
                                      },
                                      { value: 'form', label: 'Form', icon: PanelTop },
                                      {
                                        value: 'conversational',
                                        label: 'Chat',
                                        icon: MessageSquareText,
                                      },
                                    ]}
                                  />
                                </div>

                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                                  <div className="flex items-center gap-1.5">
                                    <Label className="text-xs">Checking</Label>
                                    <FieldHelp title="Answer checking">
                                      How the answer is checked. <strong>Format only</strong> runs
                                      the standard format/required checks (e.g. a valid email
                                      shape). <strong>AI</strong> adds a quick model pass that
                                      tidies the value (proper-case names, neat organisation names)
                                      and rejects obvious nonsense (&quot;asdf&quot;,
                                      &quot;test@test&quot;). <strong>Both</strong> runs the format
                                      check first, then the AI tidy/flag. The AI pass is best-effort
                                      — if it can&apos;t run, the respondent is never blocked.
                                    </FieldHelp>
                                  </div>
                                  <Select
                                    value={field.validation}
                                    onValueChange={(v) =>
                                      updateField(index, {
                                        validation: v as ProfileFieldValidationMode,
                                      })
                                    }
                                    disabled={busy}
                                  >
                                    <SelectTrigger className="h-8 w-full sm:w-56">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {PROFILE_FIELD_VALIDATION_MODES.map((m) => (
                                        <SelectItem key={m} value={m}>
                                          {PROFILE_FIELD_VALIDATION_MODE_LABELS[m]}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                                  <div className="flex items-center gap-1.5">
                                    <Label className="text-muted-foreground text-xs">
                                      Storage key
                                    </Label>
                                    <FieldHelp title="Storage key">
                                      The internal id this answer is saved under — auto-filled from
                                      the label, lowercase with underscores. You rarely need to
                                      touch it; change it only if another system reads these answers
                                      by a specific key. Avoid renaming it on a live questionnaire,
                                      or previously collected answers won&apos;t line up.
                                    </FieldHelp>
                                  </div>
                                  <Input
                                    value={field.key}
                                    placeholder="auto from label"
                                    onChange={(e) => updateFieldKey(index, e.target.value)}
                                    disabled={busy}
                                    className="h-8 w-full font-mono text-xs sm:w-56"
                                  />
                                </div>
                              </div>

                              {/* Live preview: a plain-English sentence of how this field behaves. */}
                              <div className="text-muted-foreground border-t px-4 py-2.5 text-xs">
                                <span className="text-foreground/70 font-medium">Preview · </span>
                                {describeProfileField(field, captureMode)}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addField}
                  disabled={busy}
                  className="mt-1"
                >
                  <Plus className="mr-1 h-4 w-4" /> Add profile field
                </Button>
              </>
            )}
          </SettingsGroup>
        </div>
      </div>

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
