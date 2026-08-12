'use client';

/**
 * The Adaptive Scope knobs — the master switch and everything that governs how the plan is decided.
 *
 * These live beside the topics rather than on the Settings tab because most of them *address*
 * topics: the fallback set, the blind-spot preference and every hard rule name a topic key. Split
 * across two tabs, an admin would be picking from a list they cannot see.
 *
 * Everything on this card is one PATCH of the `adaptiveScope` blob. The order of the fields follows
 * the order of the decision itself — the switch, then the cap the model cannot exceed, then the
 * blind-spot check, then what happens when the model cannot decide, then what the respondent is
 * told.
 */

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MultiSelect } from '@/components/ui/multi-select';
import { Switch } from '@/components/ui/switch';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import { SaveButton } from '@/components/admin/questionnaires/save-button';
import { ScopeRulesEditor } from '@/components/admin/questionnaires/topics/scope-rules-editor';
import {
  MAX_CONDITIONAL_TOPICS_CEILING,
  MIN_CONDITIONAL_TOPICS,
  PLANNER_INSTRUCTIONS_MAX_LENGTH,
  type AdaptiveScopeSettings,
  type ScopeRule,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

export interface ScopeSettingsCardProps {
  settings: AdaptiveScopeSettings;
  topics: readonly Topic[];
  dataSlots: TopicsPayload['inventory']['dataSlots'];
  /** Saves the settings patch. Resolving `false` means it did not land (error or declined fork). */
  onSave: (settings: AdaptiveScopeSettings) => Promise<boolean>;
  busy: boolean;
}

/** Parse a bounded integer out of a text input, falling back rather than rejecting a keystroke. */
function boundedInt(raw: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function ScopeSettingsCard({
  settings,
  topics,
  dataSlots,
  onSave,
  busy,
}: ScopeSettingsCardProps) {
  const [draft, setDraft] = useState<AdaptiveScopeSettings>(settings);
  const [dirty, setDirty] = useState(false);

  const set = (patch: Partial<AdaptiveScopeSettings>) => {
    setDirty(true);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const conditionalOptions = topics
    .filter((t) => t.phase === 'conditional')
    .map((t) => ({ value: t.key, label: t.label }));
  const conditionalCount = conditionalOptions.length;

  const save = async () => {
    const ok = await onSave(draft);
    if (ok) setDirty(false);
    return ok;
  };

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="bg-muted/30 flex-row items-start gap-3 space-y-0 border-b p-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <CardTitle className="text-sm font-semibold">Adaptive scope</CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Decide which conditional topics each respondent’s interview covers, once, when the
            opening completes. Off by default — while it is off every topic is asked and nothing
            below has any effect.
          </CardDescription>
        </div>
        <div className="mt-0.5 flex shrink-0 items-center gap-2">
          <Label htmlFor="adaptive-scope-enabled" className="text-xs font-medium">
            {draft.enabled ? 'On' : 'Off'}
          </Label>
          <Switch
            id="adaptive-scope-enabled"
            checked={draft.enabled}
            onCheckedChange={(v) => set({ enabled: v })}
            disabled={busy}
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-5 p-4">
        {draft.enabled && conditionalCount === 0 && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            No topic is conditional yet, so there is nothing to decide between — every respondent
            gets the same interview. Set at least one topic to “Ask when it fits”.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Most conditional topics per interview{' '}
              <FieldHelp title="Topic limit">
                Breadth control: how many conditional topics one interview may cover. The agent
                proposes; this caps, deterministically — a limit obeyed “most of the time” is the
                worst kind. Length and cost are governed separately by the question cap and budget.
              </FieldHelp>
            </Label>
            <Input
              type="number"
              min={MIN_CONDITIONAL_TOPICS}
              max={MAX_CONDITIONAL_TOPICS_CEILING}
              value={draft.maxConditionalTopics}
              onChange={(e) =>
                set({
                  maxConditionalTopics: boundedInt(
                    e.target.value,
                    MIN_CONDITIONAL_TOPICS,
                    MAX_CONDITIONAL_TOPICS_CEILING,
                    draft.maxConditionalTopics
                  ),
                })
              }
              disabled={busy}
            />
            {conditionalCount > 0 && draft.maxConditionalTopics >= conditionalCount && (
              <p className="text-xs text-amber-600">
                You have {conditionalCount} conditional{' '}
                {conditionalCount === 1 ? 'topic' : 'topics'}, so this limit selects all of them
                every time.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Confidence needed{' '}
              <FieldHelp title="Confidence floor">
                Below this, the agent’s plan is discarded and the fallback set applies instead. 0
                accepts any answer; 1 accepts only certainty.
              </FieldHelp>
            </Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={draft.minConfidence}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                set({
                  minConfidence: Number.isFinite(parsed)
                    ? Math.min(1, Math.max(0, parsed))
                    : draft.minConfidence,
                });
              }}
              disabled={busy}
            />
          </div>
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="scope-check-topic" className="text-sm font-medium">
                Add a blind-spot check{' '}
                <FieldHelp title="Blind-spot check">
                  Includes one topic the agent did <strong>not</strong> choose, at light depth. A
                  diagnostic that only asks about the problem the respondent already named can only
                  confirm what they already believed; sampling one area they did not raise is what
                  makes the result capable of surprising them. It is always light, whatever that
                  topic’s own depth says — in this interview its job is to sample, not to score, and
                  every report says so.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-xs">
                Costs one extra topic at light depth, over and above the limit above.
              </p>
            </div>
            <Switch
              id="scope-check-topic"
              checked={draft.includeCheckTopic}
              onCheckedChange={(v) => set({ includeCheckTopic: v })}
              disabled={busy}
            />
          </div>
          {draft.includeCheckTopic && (
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                Prefer these topics for the check, best first{' '}
                <FieldHelp title="Blind-spot preference">
                  Leave empty for “whichever unselected topic carries the most weight”, which is the
                  more informative default. Naming topics makes it predictable instead.
                </FieldHelp>
              </Label>
              <MultiSelect
                options={conditionalOptions}
                value={draft.checkTopicPreference}
                onChange={(next) => set({ checkTopicPreference: next })}
                placeholder="Any unselected topic"
                emptyText="No conditional topics yet"
                disabled={busy}
              />
            </div>
          )}
        </div>

        <div className="space-y-1.5 border-t pt-4">
          <Label className="text-sm font-medium">
            When the agent cannot decide, ask{' '}
            <FieldHelp title="Fallback topics">
              Used when the planner errored, returned nothing usable, or came in under the
              confidence floor. Empty means “the always-run topics only” — always coherent, if thin.
              The planner never throws: every failure resolves to a plan, because a respondent has
              just finished the opening and is waiting.
            </FieldHelp>
          </Label>
          <MultiSelect
            options={conditionalOptions}
            value={draft.fallbackTopicKeys}
            onChange={(next) => set({ fallbackTopicKeys: next })}
            placeholder="Always-run topics only"
            emptyText="No conditional topics yet"
            disabled={busy}
          />
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="scope-announce" className="text-sm font-medium">
                Tell the respondent what was chosen{' '}
                <FieldHelp title="Announce the plan">
                  Not merely courtesy: naming the selection back proves the interview listened,
                  justifies the time it is about to ask for, and gives the respondent their one
                  chance to object before it is spent. The interviewer weaves it into its own next
                  message rather than posting a system notice.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-xs">
                Woven into the interviewer’s own voice on the turn after the decision.
              </p>
            </div>
            <Switch
              id="scope-announce"
              checked={draft.announce}
              onCheckedChange={(v) => set({ announce: v })}
              disabled={busy}
            />
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="scope-amendment" className="text-sm font-medium">
                Let the respondent ask for a topic{' '}
                <FieldHelp title="Respondent amendment">
                  Honours “actually, ask me about talent” by adding that topic to the plan. The
                  amendment is recorded and excluded from routing-quality analytics — a correction
                  is signal <em>about</em> the planner, not an example of it working.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-xs">
                Only ever adds topics — a respondent can never remove one the instrument requires.
              </p>
            </div>
            <Switch
              id="scope-amendment"
              checked={draft.allowRespondentAmendment}
              onCheckedChange={(v) => set({ allowRespondentAmendment: v })}
              disabled={busy}
            />
          </div>
        </div>

        <div className="space-y-1.5 border-t pt-4">
          <Label className="text-sm font-medium">
            Extra guidance for the agent{' '}
            <FieldHelp title="Planner instructions">
              Appended to the planner prompt. Use it for judgement the topics’ own criteria cannot
              express — “prefer breadth over depth for first-time respondents”. It cannot override
              the limit, the rules, or the fallback: those are enforced after the model answers.
            </FieldHelp>
          </Label>
          <AutoTextarea
            value={draft.plannerInstructions}
            onChange={(e) =>
              set({ plannerInstructions: e.target.value.slice(0, PLANNER_INSTRUCTIONS_MAX_LENGTH) })
            }
            placeholder="Optional"
            rows={2}
            disabled={busy}
          />
        </div>

        <div className="border-t pt-4">
          <ScopeRulesEditor
            rules={draft.rules}
            onChange={(next: ScopeRule[]) => set({ rules: next })}
            topics={topics}
            dataSlots={dataSlots}
            disabled={busy}
          />
        </div>

        <div className="flex justify-end border-t pt-4">
          <SaveButton onSave={save} disabled={busy || !dirty} size="sm">
            Save adaptive scope
          </SaveButton>
        </div>
      </CardContent>
    </Card>
  );
}
