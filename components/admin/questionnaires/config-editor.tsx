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
import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { CostEstimateCard } from '@/components/admin/questionnaires/cost-estimate-card';
import { API } from '@/lib/api/endpoints';
import {
  CONTRADICTION_MODES,
  PROFILE_FIELD_TYPES,
  SELECTION_STRATEGIES,
  type ContradictionMode,
  type ProfileFieldConfig,
  type ProfileFieldType,
  type SelectionStrategy,
} from '@/lib/app/questionnaire/types';
import type { ConfigView } from '@/lib/app/questionnaire/views';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

const SELECTION_STRATEGY_LABELS: Record<SelectionStrategy, string> = {
  sequential: 'Sequential (in order)',
  weighted: 'Weighted (by question weight)',
  adaptive: 'Adaptive (agent-chosen)',
};

const CONTRADICTION_MODE_LABELS: Record<ContradictionMode, string> = {
  off: 'Off',
  flag: 'Flag contradictions',
  probe: 'Probe (follow up in conversation)',
};

const PROFILE_FIELD_TYPE_LABELS: Record<ProfileFieldType, string> = {
  text: 'Text',
  email: 'Email',
  number: 'Number',
  select: 'Select (choices)',
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

export function ConfigEditor({
  questionnaireId,
  versionId,
  config,
  questionCount,
  run,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  config: ConfigView;
  /** Live question count on the version — folded into the estimate's reload key so it refreshes after question edits. */
  questionCount: number;
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
  const [contradictionMode, setContradictionMode] = useState<ContradictionMode>(
    config.contradictionMode
  );
  const [contradictionWindowN, setContradictionWindowN] = useState(
    String(config.contradictionWindowN)
  );
  const [anonymousMode, setAnonymousMode] = useState(config.anonymousMode);
  const [profileFields, setProfileFields] = useState<ProfileFieldRow[]>(
    config.profileFields.map(toRow)
  );

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
    setContradictionMode(config.contradictionMode);
    setContradictionWindowN(String(config.contradictionWindowN));
    setAnonymousMode(config.anonymousMode);
    setProfileFields(config.profileFields.map(toRow));
  }, [config]);

  const contradictionOff = contradictionMode === 'off';

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
        contradictionMode,
        // The schema forces N=0 when off and ≥1 otherwise — keep the body coherent.
        contradictionWindowN: contradictionOff
          ? 0
          : boundedNumber(contradictionWindowN, 1, Number.MAX_SAFE_INTEGER, 1, true),
        anonymousMode,
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
    <section className="space-y-5 rounded-md border p-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Configuration</h3>
        <FieldHelp title="Run-time configuration">
          Controls how a session runs once this version is launched. A configuration must be saved
          at least once before the version can be launched.
        </FieldHelp>
        {!config.saved && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
            Not yet saved
          </span>
        )}
      </div>

      {/* Selection + completion */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
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
              {SELECTION_STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SELECTION_STRATEGY_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">
            Min questions answered{' '}
            <FieldHelp title="Minimum questions answered">
              A session can&apos;t complete until at least this many questions have been answered. 0
              means no minimum.
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

      {/* Budget & caps */}
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

      {/* Modes */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Switch checked={voiceEnabled} onCheckedChange={setVoiceEnabled} disabled={busy} />
          <Label className="text-sm font-medium">
            Voice input{' '}
            <FieldHelp title="Voice input">
              Let respondents answer by voice as well as text.
            </FieldHelp>
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={anonymousMode} onCheckedChange={setAnonymousMode} disabled={busy} />
          <Label className="text-sm font-medium">
            Anonymous mode{' '}
            <FieldHelp title="Anonymous mode">
              Don&apos;t collect identifying profile fields at session start — responses aren&apos;t
              tied to a named individual.
            </FieldHelp>
          </Label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
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
              min={contradictionOff ? 0 : 1}
              value={contradictionOff ? 0 : contradictionWindowN}
              onChange={(e) => setContradictionWindowN(e.target.value)}
              disabled={busy || contradictionOff}
            />
          </div>
        </div>
      </div>

      {/* Profile fields */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">
            Session-start profile fields{' '}
            <FieldHelp title="Profile fields">
              Fields collected from the respondent before the questionnaire starts (name, email,
              role, organisation, or any custom field). Each needs a unique key.
            </FieldHelp>
          </Label>
        </div>
        {profileFields.length === 0 ? (
          <p className="text-muted-foreground text-sm italic">No profile fields.</p>
        ) : (
          <div className="space-y-3">
            {profileFields.map((field, index) => (
              <div key={index} className="space-y-2 rounded-md border p-3">
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
      </div>

      <Button size="sm" disabled={busy} onClick={save}>
        Save configuration
      </Button>
    </section>
  );
}
