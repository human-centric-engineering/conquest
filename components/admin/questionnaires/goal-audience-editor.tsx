'use client';

/**
 * GoalAudienceEditor — the version's goal + audience metadata, edited inline on the Structure tab.
 *
 * Goal/audience describe what the questionnaire is trying to learn and who answers it. The read-only
 * Structure view ({@link VersionGraph}) shows them in the goal band at the top; this is the editable
 * counterpart, rendered at the top of the Structure editor ({@link VersionEditor}) so admins edit
 * them right where they see them. Presentational: controlled state seeded from props, saved through
 * the parent's `run` mutation runner (which applies the fork-on-launch discipline) — same pattern as
 * {@link ConfigEditor}.
 *
 * When `designEvalEnabled` is on, the header explains that the structure review (Evaluations tab)
 * scores questions against these fields, and a help popover lists which reviewers read them.
 */

import { useEffect, useState } from 'react';

import { SaveButton } from '@/components/admin/questionnaires/save-button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { API } from '@/lib/api/endpoints';
import {
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
  type AudienceExpertiseLevel,
  type AudienceSensitivity,
  type AudienceShape,
} from '@/lib/app/questionnaire/types';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

/** Radix Select forbids an empty-string item value, so "unset" needs a sentinel. */
const UNSET = '__unset__';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface GoalAudienceEditorProps {
  questionnaireId: string;
  versionId: string;
  goal: string | null;
  audience: AudienceShape | null;
  run: RunMutation;
  busy: boolean;
  /** When on, surface the structure-review explanation + reviewer help (Evaluations tab). */
  designEvalEnabled?: boolean;
}

export function GoalAudienceEditor({
  questionnaireId,
  versionId,
  goal: goalProp,
  audience: audienceProp,
  run,
  busy,
  designEvalEnabled = false,
}: GoalAudienceEditorProps) {
  const [goal, setGoal] = useState(goalProp ?? '');
  const [audience, setAudience] = useState<AudienceShape>(audienceProp ?? {});

  // Resync from the server graph after each refetch (mirrors the config/version editors).
  useEffect(() => {
    setGoal(goalProp ?? '');
    setAudience(audienceProp ?? {});
  }, [goalProp, audienceProp]);

  // Set or clear a single audience field — dropping empties so an emptied form saves `audience: null`
  // rather than a husk of undefined keys.
  const setField = <K extends keyof AudienceShape>(key: K, value: AudienceShape[K] | undefined) =>
    setAudience((prev) => {
      const next = { ...prev };
      if (value === undefined || value === '') delete next[key];
      else next[key] = value;
      return next;
    });

  const save = () =>
    run(() => [
      'PATCH',
      API.APP.QUESTIONNAIRES.versionGraph(questionnaireId, versionId),
      {
        goal: goal.trim() === '' ? null : goal,
        audience: Object.keys(audience).length ? audience : null,
      },
    ]);

  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-semibold tracking-tight">Goal &amp; audience</h3>
          {designEvalEnabled && (
            <FieldHelp
              title="How the structure review uses this"
              ariaLabel="How goal and audience are used by the structure review"
              contentClassName="w-80"
            >
              <p>
                When you run a <strong>structure review</strong> on the <strong>Evaluations</strong>{' '}
                tab, these AI reviewers read the goal and audience to score your questions before
                launch:
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                <li>
                  <strong>Coverage</strong> — do the questions cover the whole goal? Flags gaps.
                </li>
                <li>
                  <strong>Goal match</strong> — does every question serve the goal? Flags
                  off-mission questions.
                </li>
                <li>
                  <strong>Audience match</strong> — is the wording, reading level, and length right
                  for this audience?
                </li>
              </ul>
              <p className="mt-1">
                The other reviewers (clarity, duplicates, type fit, ordering) don’t rely on these
                fields.
              </p>
            </FieldHelp>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          {designEvalEnabled
            ? 'What this questionnaire is trying to learn and who answers it. The conversation tunes its tone to the audience, and the structure review on the Evaluations tab scores your questions against this goal and audience.'
            : 'What this questionnaire is trying to learn and who answers it. The conversation tunes its tone to the audience.'}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ga-goal" className="text-sm font-medium">
          Goal{' '}
          <FieldHelp title="Questionnaire goal">
            What this questionnaire is trying to learn. The structure review (Evaluations tab)
            scores your questions against this. Leave blank to clear it.
          </FieldHelp>
        </Label>
        <Textarea
          id="ga-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
          disabled={busy}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ga-role" className="text-sm font-medium">
            Audience role{' '}
            <FieldHelp title="Audience role">
              Who completes this questionnaire (e.g. “patient”, “new hire”). Tunes the
              conversation’s tone, and lets the structure review check the questions fit this
              audience.
            </FieldHelp>
          </Label>
          <Input
            id="ga-role"
            value={audience.role ?? ''}
            onChange={(e) => setField('role', e.target.value || undefined)}
            disabled={busy}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ga-description" className="text-sm font-medium">
            Audience description
          </Label>
          <Input
            id="ga-description"
            value={audience.description ?? ''}
            onChange={(e) => setField('description', e.target.value || undefined)}
            disabled={busy}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Expertise level</Label>
          <Select
            value={audience.expertiseLevel ?? UNSET}
            onValueChange={(v) =>
              setField('expertiseLevel', v === UNSET ? undefined : (v as AudienceExpertiseLevel))
            }
            disabled={busy}
          >
            <SelectTrigger aria-label="Expertise level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>Not set</SelectItem>
              {AUDIENCE_EXPERTISE_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {cap(level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ga-duration" className="text-sm font-medium">
            Est. duration (min)
          </Label>
          <Input
            id="ga-duration"
            type="number"
            min={1}
            step={1}
            value={audience.estimatedDurationMinutes ?? ''}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              setField(
                'estimatedDurationMinutes',
                e.target.value === '' || !Number.isFinite(n) || n <= 0 ? undefined : n
              );
            }}
            disabled={busy}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ga-locale" className="text-sm font-medium">
            Locale{' '}
            <FieldHelp title="Audience locale">
              BCP-47 language tag the conversation speaks in (e.g. <code>en</code>,{' '}
              <code>en-GB</code>, <code>fr</code>). Defaults to <code>en</code> when unset.
            </FieldHelp>
          </Label>
          <Input
            id="ga-locale"
            value={audience.locale ?? ''}
            onChange={(e) => setField('locale', e.target.value || undefined)}
            placeholder="en"
            disabled={busy}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">
            Sensitivity{' '}
            <FieldHelp title="Audience sensitivity">
              How sensitive the subject matter is for this audience. Higher sensitivity nudges the
              conversation toward a gentler, more careful tone.
            </FieldHelp>
          </Label>
          <Select
            value={audience.sensitivity ?? UNSET}
            onValueChange={(v) =>
              setField('sensitivity', v === UNSET ? undefined : (v as AudienceSensitivity))
            }
            disabled={busy}
          >
            <SelectTrigger aria-label="Sensitivity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>Not set</SelectItem>
              {AUDIENCE_SENSITIVITY_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {cap(level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ga-notes" className="text-sm font-medium">
          Audience notes
        </Label>
        <Textarea
          id="ga-notes"
          value={audience.notes ?? ''}
          onChange={(e) => setField('notes', e.target.value || undefined)}
          rows={2}
          disabled={busy}
        />
      </div>

      <SaveButton size="sm" disabled={busy} onSave={save}>
        Save goal &amp; audience
      </SaveButton>
    </section>
  );
}
