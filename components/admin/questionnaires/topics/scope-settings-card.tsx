'use client';

/**
 * The Conditional Topics knobs — the master switch and everything that governs how the plan is decided.
 *
 * These live beside the topics rather than on the Settings tab because most of them *address*
 * topics: the fallback set, the blind-spot preference and every hard rule name a topic key. Split
 * across two tabs, an admin would be picking from a list they cannot see.
 *
 * Everything on this card is one PATCH of the `conditionalTopics` blob. The order of the fields follows
 * the order of the decision itself, and the steps are numbered to say so: the hard rules that run
 * before the agent, then the cap the model cannot exceed, the blind-spot check, what happens when
 * the model cannot decide, and what the respondent is told.
 *
 * Numbering them is not decoration. The failure this card exists to prevent is an admin reading the
 * cap as a request the model tries to honour; seeing it sit *after* the agent's turn in a sequence
 * they cannot reorder is the cheapest way to say that it is enforced.
 */

import type React from 'react';
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
  MAX_OPENING_PROBES_CEILING,
  MAX_SESSION_BUDGET_SECONDS,
  MIN_CONDITIONAL_TOPICS,
  MIN_OPENING_PROBES,
  PLANNER_INSTRUCTIONS_MAX_LENGTH,
  type ConditionalTopicsSettings,
  type ScopeRule,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';
import { cn } from '@/lib/utils';

export interface ScopeSettingsCardProps {
  settings: ConditionalTopicsSettings;
  topics: readonly Topic[];
  dataSlots: TopicsPayload['inventory']['dataSlots'];
  /**
   * The version's time arithmetic (C7), computed server-side: what the always-run questions cost
   * and what a budget therefore leaves for routed topics.
   */
  costs: TopicsPayload['costs'];
  /** Saves the settings patch. Resolving `false` means it did not land (error or declined fork). */
  onSave: (settings: ConditionalTopicsSettings) => Promise<boolean>;
  busy: boolean;
}

/**
 * The arithmetic behind a session budget, stated rather than left implicit.
 *
 * Without this an author sets "600" and has no way to know that most of it is already spent — the
 * questions every respondent gets come out of the same budget, and what is left is the only number
 * that decides how much routing is possible. This is the line that turns a client's "no more than
 * three sections" from folklore into something an author can check.
 *
 * Reads the SAVED figures, so it lags an unsaved topic edit by one save. Stated in the copy rather
 * than hidden, because a number that silently described a different instrument would be worse.
 */
function BudgetReadout({
  budgetSeconds,
  costs,
}: {
  budgetSeconds: number;
  costs: TopicsPayload['costs'];
}) {
  if (budgetSeconds <= 0) return null;
  const allowance = Math.max(0, budgetSeconds - costs.alwaysSeconds);
  const overspent = costs.alwaysSeconds >= budgetSeconds;
  return (
    <p className={cn('text-xs', overspent ? 'text-amber-600' : 'text-muted-foreground')}>
      {overspent ? (
        <>
          The questions every respondent gets already take about{' '}
          {formatSeconds(costs.alwaysSeconds)}, which is over this budget. No conditional topic can
          fit.
        </>
      ) : (
        <>
          About {formatSeconds(costs.alwaysSeconds)} goes to the questions every respondent gets,
          leaving ~{formatSeconds(allowance)} for conditional topics.
        </>
      )}
    </p>
  );
}

/**
 * A numbered step heading inside the card.
 *
 * The numbers are the DECISION ORDER, not a wizard: hard rules really are evaluated before the
 * agent, and the agent's answer really is filtered by the limits that follow. Ordering the controls
 * the way the runtime orders them is what stops an admin reading the cap as something the model
 * merely tries to respect. `step` is omitted for the aside that has no place in that sequence.
 */
function SectionLabel({ step, children }: { step?: number; children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-[11px] font-semibold tracking-wide uppercase">
      {step !== undefined && (
        <span
          aria-hidden="true"
          className="bg-muted text-foreground/70 flex h-5 w-5 items-center justify-center rounded-full text-[10px] tabular-nums"
        >
          {step}
        </span>
      )}
      {children}
    </p>
  );
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
  costs,
  onSave,
  busy,
}: ScopeSettingsCardProps) {
  const [draft, setDraft] = useState<ConditionalTopicsSettings>(settings);
  const [dirty, setDirty] = useState(false);

  const set = (patch: Partial<ConditionalTopicsSettings>) => {
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
          <CardTitle className="flex items-center gap-1.5 text-sm font-semibold">
            How the decision is made
            <FieldHelp title="The decision, in order">
              <p>
                Once the opening completes, the interview&rsquo;s scope is settled in one pass and
                never revisited:
              </p>
              <ol className="mt-2 list-decimal space-y-1 pl-4">
                <li>
                  The <strong>opening</strong> gathers the signal, within whatever follow-up
                  allowance you set. It is the only step that happens before the decision.
                </li>
                <li>
                  Your <strong>hard rules</strong> run first. A “never include” can never be undone
                  by anything below it.
                </li>
                <li>
                  The <strong>agent</strong> judges each remaining conditional topic against its
                  criteria and what the respondent said.
                </li>
                <li>
                  Your <strong>limits</strong> are applied to the result — the cap, the confidence
                  floor, the blind-spot check.
                </li>
                <li>
                  If nothing usable survives, the <strong>fallback</strong> applies. It never fails
                  and never hangs.
                </li>
              </ol>
              <p className="mt-2">
                The model proposes; it never gets the last word on a limit you set.
              </p>
            </FieldHelp>
          </CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Decide which conditional topics each respondent’s interview covers, once, when the
            opening completes. The on/off switch is in the header at the top of this tab; while it
            is off, every topic is asked and nothing below has any effect.
          </CardDescription>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 p-4">
        {settings.enabled && conditionalCount === 0 && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            No topic is conditional yet, so there is nothing to decide between — every respondent
            gets the same interview. Set at least one topic to “Ask when it fits”.
          </p>
        )}

        <div className="space-y-3">
          <SectionLabel step={1}>Before the decision — what the opening may spend</SectionLabel>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="scope-limit-probes" className="text-sm font-medium">
                Limit follow-up questions in the opening{' '}
                <FieldHelp title="Opening follow-ups">
                  <p>
                    A <strong>follow-up</strong> is the interview circling back on something it has
                    already asked, because the answer was too vague to route on. It is the most
                    useful thing an interviewer does and the most expensive: every follow-up spends
                    a turn that could have gone on one of the topics the agent chose.
                  </p>
                  <p>
                    The allowance is shared across the <strong>whole opening</strong>, not per
                    question — which is the thing “attempts per data slot” on the Settings tab
                    cannot express, because it has no idea a follow-up was already spent three
                    questions ago.
                  </p>
                  <p>
                    Before spending one, the agent checks whether what the respondent has already
                    said is enough to choose topics from. If it is, the follow-up is not asked — the
                    failure this exists to prevent is probing an answer that was already specific
                    enough.
                  </p>
                  <p>
                    Off by default. It only ever <em>removes</em> questions: it can never make the
                    interview ask more than the per-slot limit you set elsewhere.
                  </p>
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-xs">
                Off means the opening follows up as often as the per-slot limit allows.
              </p>
            </div>
            <Switch
              id="scope-limit-probes"
              checked={draft.limitOpeningProbes}
              onCheckedChange={(v) => set({ limitOpeningProbes: v })}
              disabled={busy}
            />
          </div>
          {draft.limitOpeningProbes && (
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">
                Follow-ups allowed across the whole opening
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  className="max-w-28"
                  min={MIN_OPENING_PROBES}
                  max={MAX_OPENING_PROBES_CEILING}
                  value={draft.maxOpeningProbes}
                  onChange={(e) =>
                    set({
                      maxOpeningProbes: boundedInt(
                        e.target.value,
                        MIN_OPENING_PROBES,
                        MAX_OPENING_PROBES_CEILING,
                        draft.maxOpeningProbes
                      ),
                    })
                  }
                  disabled={busy}
                />
                <span className="text-muted-foreground shrink-0 text-xs">
                  {draft.maxOpeningProbes === 0
                    ? 'never follow up'
                    : draft.maxOpeningProbes === 1
                      ? 'one, for the whole opening'
                      : `${draft.maxOpeningProbes} in total`}
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-3 border-t pt-4">
          {/* The data-slot dependency is named in the heading itself, not left to the ⓘ. A rule
              tests one data slot, so with none on the version there is nothing to author a rule
              against — and the admin who most needs telling is the one who never opens the help. */}
          {/* Names the ACTION, not a category. "The cases you are certain about" told an admin
              nothing about what to put in the field — "cases" is an abstraction, and the data-slot
              dependency read as decoration rather than as the thing the rule is built from. */}
          <SectionLabel step={2}>Always or never ask a topic based on one answer</SectionLabel>
          <ScopeRulesEditor
            rules={draft.rules}
            onChange={(next: ScopeRule[]) => set({ rules: next })}
            topics={topics}
            dataSlots={dataSlots}
            disabled={busy}
          />
        </div>

        <div className="space-y-3 border-t pt-4">
          <SectionLabel step={3}>How much the agent may cover</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                How long an interview may take{' '}
                <FieldHelp title="How long an interview may take">
                  <p>
                    Duration control: roughly how long one interview may take. Leave at 0 for no
                    limit.
                  </p>
                  <p>
                    Separate from the topic limit beside it, because they bound different things.
                    Three topics is not a length — one topic can be ten ratings and another three —
                    and “under ten minutes” says nothing about how many areas to cover. Both apply.
                  </p>
                  <p>
                    Estimated from question types (a rating is quick, an open question is not), so
                    it is a planning figure rather than a stopwatch.
                  </p>
                </FieldHelp>
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={MAX_SESSION_BUDGET_SECONDS}
                  step={30}
                  value={draft.sessionBudgetSeconds}
                  onChange={(e) =>
                    set({
                      sessionBudgetSeconds: boundedInt(
                        e.target.value,
                        0,
                        MAX_SESSION_BUDGET_SECONDS,
                        draft.sessionBudgetSeconds
                      ),
                    })
                  }
                  disabled={busy}
                />
                <span className="text-muted-foreground shrink-0 text-xs">
                  {draft.sessionBudgetSeconds > 0
                    ? formatSeconds(draft.sessionBudgetSeconds)
                    : 'no limit'}
                </span>
              </div>
              <BudgetReadout budgetSeconds={draft.sessionBudgetSeconds} costs={costs} />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                Most conditional topics per interview{' '}
                <FieldHelp title="How many topics">
                  Breadth control: how many conditional topics one interview may cover. The agent
                  proposes; this limit is applied in code afterwards, not asked of the AI — a limit
                  obeyed “most of the time” is the worst kind. Length and cost are governed
                  separately by the question cap and budget.
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
                How sure the AI must be{' '}
                <FieldHelp title="How sure the AI must be">
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
        </div>

        <div className="space-y-2 border-t pt-4">
          <SectionLabel step={4}>Guard against a narrow result</SectionLabel>
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
                <FieldHelp title="Which topic to sample">
                  Leave empty for “whichever unchosen topic matters most”, which is the more
                  informative default. Naming topics makes it predictable instead.
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
          <SectionLabel step={5}>When the agent cannot decide</SectionLabel>
          <Label className="text-sm font-medium">
            Ask these instead{' '}
            <FieldHelp title="Ask these instead">
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
          <SectionLabel step={6}>What the respondent is told</SectionLabel>
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
                  Honours “actually, can we cover training too?” by adding that topic to the plan,
                  whether or not the agent chose it. Matched against your topic names, so names that
                  describe the subject are what make this work. The amendment is recorded and
                  excluded from routing-quality analytics — a correction is signal <em>about</em>{' '}
                  the planner, not an example of it working.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-xs">
                Only ever adds topics — a respondent can never remove one the questionnaire
                requires.
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
          <SectionLabel>Extra guidance (optional)</SectionLabel>
          <Label className="text-sm font-medium">
            Guidance that applies across all topics{' '}
            <FieldHelp title="Extra guidance">
              <strong>Advice that applies to every topic at once.</strong> Each topic’s criteria say
              when <em>that</em> topic applies. This says how to weigh up the whole set, so it’s for
              anything that isn’t about one topic in particular.
              <br />
              <br />
              <em>
                “For a first-time respondent, prefer covering more areas briefly than one in depth.”
              </em>{' '}
              <em>“Where they seem unsure, favour the areas they raised themselves.”</em>
              <br />
              <br />
              It’s advice, not a rule: the agent weighs it up rather than obeying it, so anything
              you can’t compromise on belongs in a hard rule. It can’t stretch the topic limit,
              overrule a hard rule, or change the fallback list; those are applied afterwards
              whatever this says. It also doesn’t change how questions are worded, only which topics
              get covered.
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

        <div className="flex justify-end border-t pt-4">
          <SaveButton onSave={save} disabled={busy || !dirty} size="sm">
            Save conditional topics
          </SaveButton>
        </div>
      </CardContent>
    </Card>
  );
}
