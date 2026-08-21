'use client';

/**
 * Editor for the "Interviewer strategy" group on the Settings tab.
 *
 * Lives in its own file rather than inside `config-editor.tsx` for the same reason the house-rules
 * panel does: that file is already ~2900 lines, and the opening-examples list is a real sub-editor
 * rather than a field.
 *
 * Three deliberate choices:
 *
 *  - **The arc is shown, not described.** The funnel's phases were previously explained in prose
 *    that could not answer the admin's actual question ("is it just the first few questions, or a
 *    gradual descent?"). {@link FunnelArcExplainer} renders the bands from the SAME
 *    `FUNNEL_PACE_PROFILES` the runtime reads, so the numbers on screen cannot drift from the
 *    numbers in the prompt — the house-rules preview's trick, applied to a table instead of text.
 *  - **One pace dial, not four numbers.** See `FunnelPaceProfile`: the window and thresholds are not
 *    independently meaningful. The dial is shown only for `funnel`, matching `paceProfile()`, which
 *    honours it only there.
 *  - **Examples are plain strings.** Unlike house rules there is nothing to toggle or reorder — the
 *    prompt presents them as one set — so per-item ids would be ceremony.
 *
 * @see lib/app/questionnaire/chat/interviewer-strategy.ts — the runtime this mirrors
 * @see .context/app/questionnaire/interviewer-strategy.md
 */

import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { OpeningExamplesSuggest } from '@/components/admin/questionnaires/opening-examples-suggest';
import { cn } from '@/lib/utils';
import {
  FUNNEL_PACE_PROFILES,
  usesGuidedOpening,
  type FunnelPaceProfile,
} from '@/lib/app/questionnaire/chat/interviewer-strategy';
import {
  FUNNEL_PACES,
  FUNNEL_PACE_LABELS,
  INTERVIEWER_APPROACHES,
  INTERVIEWER_APPROACH_LABELS,
  MAX_OPENING_EXAMPLES,
  OPENING_EXAMPLE_MAX,
  type FunnelPace,
  type InterviewerApproach,
  type InterviewerOpeningMode,
  type InterviewerStrategySettings,
} from '@/lib/app/questionnaire/types';

/** "2 questions" / "1 question" — the opening window reads as a count, not a constant. */
function askCount(n: number): string {
  return n === 1 ? '1 question' : `${n} questions`;
}

/** Coverage fractions are stored 0–1 but only ever shown as whole percentages. */
function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** One row of the arc table: when it applies, and what the interviewer does then. */
function ArcRow({ when, does }: { when: string; does: string }) {
  return (
    <div className="grid grid-cols-[9.5rem_1fr] gap-x-3 gap-y-0.5 py-1 max-sm:grid-cols-1">
      <dt className="text-foreground text-xs font-medium">{when}</dt>
      <dd className="text-muted-foreground text-xs">{does}</dd>
    </div>
  );
}

/**
 * "How this plays out" — the arc, in plain English, derived live from the pace profile.
 *
 * This exists because the previous help text ("as coverage builds it steers toward the specific
 * points still missing") could not tell an admin whether the openness is a two-question preamble or
 * a gradual descent. It is both, and the only honest way to say so is to show the bands.
 */
export function FunnelArcExplainer({
  approach,
  profile,
}: {
  approach: InterviewerApproach;
  profile: FunnelPaceProfile;
}) {
  // Targeted has no arc — every question is one specific ask, from the first turn to the last.
  if (approach === 'targeted') return null;

  return (
    <div className="bg-muted/40 space-y-2 rounded-lg border p-3">
      <p className="text-foreground text-xs font-semibold">How this plays out</p>
      <dl className="divide-border/60 divide-y">
        {approach === 'funnel' ? (
          <>
            <ArcRow
              when={`First ${askCount(profile.openingWindow)}`}
              does="A wide, permission-giving opener — talk freely, no right or wrong answers."
            />
            <ArcRow
              when={`Up to ${pct(profile.openBelow)} covered`}
              does="Broad invitations about the general area, rather than the specific question, so one long answer can fill several gaps."
            />
            <ArcRow
              when={`${pct(profile.openBelow)}–${pct(profile.targetedAbove)} covered`}
              does="Still open and conversational, but steering toward the points still missing."
            />
            <ArcRow
              when={`Over ${pct(profile.targetedAbove)} covered`}
              does="One specific, concrete question at a time, to close the last gaps briskly."
            />
          </>
        ) : (
          <>
            <ArcRow
              when={`First ${askCount(profile.openingWindow)}`}
              does="A wide, permission-giving opener — talk freely, no right or wrong answers."
            />
            <ArcRow
              when="After that"
              does="Broad, exploratory invitations the whole way, loosely guided by what is still missing. It never narrows to one specific question."
            />
          </>
        )}
      </dl>
      {approach === 'funnel' && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-[11px]">
          <li>
            Short answers move it on one band sooner — if broad invitations aren&rsquo;t drawing
            people out, it gets specific rather than persisting.
          </li>
          <li>
            Before anything is captured there is no coverage to read, so it counts questions
            instead: open for the first {profile.openRounds}, specific from question{' '}
            {profile.targetedRounds + 1}.
          </li>
        </ul>
      )}
    </div>
  );
}

/**
 * The opening-question mode picker. Two mutually-exclusive modes, so a segmented radio group reads
 * better than a dropdown — both options and the difference between them stay visible.
 */
function OpeningModePicker({
  value,
  onChange,
  disabled,
}: {
  value: InterviewerOpeningMode;
  onChange: (next: InterviewerOpeningMode) => void;
  disabled?: boolean;
}) {
  const options: ReadonlyArray<{ mode: InterviewerOpeningMode; label: string; hint: string }> = [
    {
      mode: 'auto',
      label: 'Let the interviewer choose',
      hint: 'It varies its own opening between several framings, so different respondents get different openings.',
    },
    {
      mode: 'examples',
      label: 'Guide it with examples',
      hint: 'Write a few openers of your own. It writes its own question in the same spirit — it does not read yours out.',
    },
  ];

  return (
    <div role="radiogroup" aria-label="Where the opening question comes from" className="space-y-2">
      {options.map((option) => {
        const selected = value === option.mode;
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
            className={cn(
              'w-full rounded-lg border p-2.5 text-left transition-colors',
              selected ? 'border-sky-500/50 bg-sky-500/5' : 'hover:bg-muted/50',
              disabled && 'pointer-events-none opacity-60'
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                  selected ? 'border-sky-500' : 'border-muted-foreground/40'
                )}
                aria-hidden="true"
              >
                {selected && <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />}
              </span>
              <span className="text-sm font-medium">{option.label}</span>
            </span>
            <span className="text-muted-foreground mt-1 block pl-[1.375rem] text-xs">
              {option.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function InterviewerStrategyPanel({
  value,
  onChange,
  disabled,
  questionnaireId,
  versionId,
}: {
  value: InterviewerStrategySettings;
  onChange: (next: InterviewerStrategySettings) => void;
  disabled?: boolean;
  /**
   * Ids for the suggest route. Optional so the panel still renders standalone (and in tests)
   * without one — the AI affordance simply doesn't appear, and every other control still works.
   */
  questionnaireId?: string;
  versionId?: string;
}) {
  const patch = (next: Partial<InterviewerStrategySettings>) => onChange({ ...value, ...next });

  const { enabled, approach, pace, openingMode, openingExamples } = value;
  // Mirrors `paceProfile()` exactly: the dial is honoured for funnel only, so the explainer must
  // show the balanced arc for `open` however the stored pace reads.
  const profile =
    approach === 'funnel' ? FUNNEL_PACE_PROFILES[pace] : FUNNEL_PACE_PROFILES.balanced;
  // Examples only ever govern an OPEN opening, which `targeted` never has.
  const opensBroadly = approach === 'funnel' || approach === 'open';
  const atCap = openingExamples.length >= MAX_OPENING_EXAMPLES;
  const blankIndex = openingExamples.findIndex((example) => example.trim() === '');
  /**
   * The cap as the SUGGESTER sees it. A blank row is capacity `addExample` can use without growing
   * the list, so five rows one of which is empty is not full to the assistant — only to the "Add an
   * example" button, which would have to add a sixth. Without this distinction the exact case
   * `addExample`'s blank-row branch exists for (click "Add an example", then open the assistant, at
   * five rows) disables every proposal's Add button and the blank row can never be filled.
   */
  const suggestAtCap = atCap && blankIndex < 0;

  const setExamples = (next: string[]) => patch({ openingExamples: next });
  const setExample = (index: number, text: string) =>
    setExamples(openingExamples.map((example, i) => (i === index ? text : example)));

  /**
   * Accepting a suggestion fills the first blank row if there is one, rather than always appending.
   * An admin who clicked "Add an example" and then opened the assistant would otherwise be left
   * with an empty row above the accepted opener — and that empty row makes the list read as
   * unfinished (and trips the panel's own "nothing written yet" warning).
   */
  const addExample = (text: string) => {
    if (blankIndex >= 0) return setExample(blankIndex, text);
    if (atCap) return;
    setExamples([...openingExamples, text]);
  };

  // Matched on exact text so an accepted-then-edited opener stops counting as "added" — at which
  // point offering it again is right, not a duplicate. Same call as the house-rules library.
  const addedTexts = new Set(openingExamples);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={(next) => patch({ enabled: next })}
          disabled={disabled}
          aria-label="Override the default questioning approach"
        />
        <Label className="text-sm font-medium">
          Override the default questioning approach{' '}
          <FieldHelp title="Interviewer strategy">
            <p>
              By default the interviewer prompt tells it to{' '}
              <strong>ask the one provided question, one thing at a time</strong>, phrased as an
              open invitation (“Tell me about…”), in a neutral register.
            </p>
            <p className="mt-2">
              When on, an <code className="text-xs">&lt;interviewer_strategy&gt;</code> block is
              appended to the prompt <em>after</em> those default rules — so it takes precedence —
              carrying the approach and tactics below. When off, that block is omitted entirely and
              nothing about the default changes.
            </p>
          </FieldHelp>
        </Label>
      </div>

      {enabled && (
        <div className="border-border/60 ml-1 space-y-4 border-l pl-4">
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[13rem] flex-1 space-y-1.5 sm:max-w-xs">
              <Label className="text-sm font-medium">
                Approach{' '}
                <FieldHelp title="Approach">
                  <p>
                    The questioning-approach clause added to the prompt. It sets how open vs.
                    targeted each ask is — the panel below spells out what the choice means turn by
                    turn.
                  </p>
                  <ul className="mt-2 list-disc space-y-2 pl-4">
                    <li>
                      <strong>Funnel (open → targeted)</strong> — a coverage-driven arc: broad
                      invitations while little is captured, narrowing to specific questions as the
                      questionnaire fills. Best all-rounder.
                    </li>
                    <li>
                      <strong>Open throughout</strong> — broad and exploratory the whole way, and it
                      never narrows. Best for rich, qualitative discovery where completeness matters
                      less than depth.
                    </li>
                    <li>
                      <strong>Targeted / efficient</strong> — one specific, concrete question at a
                      time with minimal preamble. Best for factual questionnaires and fastest
                      completion.
                    </li>
                  </ul>
                </FieldHelp>
              </Label>
              <Select
                value={approach}
                onValueChange={(v) => patch({ approach: v as InterviewerApproach })}
                disabled={disabled}
              >
                <SelectTrigger aria-label="Approach">
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

            {/* Pace only exists for the funnel — `open` and `targeted` have no arc to pace, and the
                runtime ignores a stored pace for them. */}
            {approach === 'funnel' && (
              <div className="min-w-[13rem] flex-1 space-y-1.5 sm:max-w-xs">
                <Label className="text-sm font-medium">
                  Pace{' '}
                  <FieldHelp title="Pace">
                    <p>
                      How quickly the funnel narrows from broad invitations to specific questions.
                      One dial rather than several numbers: the length of the opening and both
                      switch-over points move together, so the arc always stays coherent.
                    </p>
                    <ul className="mt-2 list-disc space-y-2 pl-4">
                      <li>
                        <strong>Stay open longer</strong> — more of the conversation is exploratory.
                        Richer material, more turns, and a higher chance of gaps left to fill at the
                        end.
                      </li>
                      <li>
                        <strong>Balanced</strong> — the default, and unchanged from how this
                        questionnaire behaved before this setting existed.
                      </li>
                      <li>
                        <strong>Narrow quickly</strong> — one broad opener, then it gets specific
                        fast. Best when completion rate matters more than depth, or the questions
                        are largely factual.
                      </li>
                    </ul>
                    <p className="mt-2">
                      Whichever you pick, short answers still move it on a band sooner — the arc
                      responds to the person, not just the clock.
                    </p>
                  </FieldHelp>
                </Label>
                <Select
                  value={pace}
                  onValueChange={(v) => patch({ pace: v as FunnelPace })}
                  disabled={disabled}
                >
                  <SelectTrigger aria-label="Pace">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FUNNEL_PACES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {FUNNEL_PACE_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <FunnelArcExplainer approach={approach} profile={profile} />

          {opensBroadly && (
            <div className="space-y-2.5">
              <Label className="text-sm font-medium">
                Opening questions{' '}
                <FieldHelp title="Opening questions">
                  <p>
                    How the interviewer decides what to open with. The opening matters more than any
                    other turn: a wide, easy first question is what gets people talking at length,
                    and one long answer can fill several questions at once.
                  </p>
                  <p className="mt-2">
                    Your examples are <strong>guidance, not a script</strong>. The interviewer is
                    told to match their breadth, register and the kind of thinking they invite, then
                    write its own — and explicitly told not to read one out. Different respondents
                    still get different openings.
                  </p>
                  <p className="mt-2">
                    They shape the <strong>opening only</strong> — the first{' '}
                    {askCount(profile.openingWindow)} of the conversation. Later questions follow
                    the approach above.
                  </p>
                  <p className="mt-2">
                    Leave the list empty and it falls back to choosing its own opening, so switching
                    this on before you have written anything changes nothing.
                  </p>
                </FieldHelp>
              </Label>

              <OpeningModePicker
                value={openingMode}
                onChange={(next) => patch({ openingMode: next })}
                disabled={disabled}
              />

              {openingMode === 'examples' && (
                <div className="space-y-2">
                  {openingExamples.map((example, index) => (
                    // Index keys are correct here: the list is short, unordered, and an entry has no
                    // identity beyond its position — removing one genuinely shifts the rest up.
                    <div key={index} className="space-y-1">
                      <div className="flex items-start gap-2">
                        <Textarea
                          value={example}
                          maxLength={OPENING_EXAMPLE_MAX}
                          rows={2}
                          aria-label={`Example opening question ${index + 1}`}
                          placeholder="Tell me about your experience of working here — anything that stands out."
                          disabled={disabled}
                          onChange={(e) => setExample(index, e.target.value)}
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive mt-1 h-7 w-7 shrink-0"
                          aria-label={`Remove example ${index + 1}`}
                          disabled={disabled}
                          onClick={() => setExamples(openingExamples.filter((_, i) => i !== index))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <p className="text-muted-foreground pr-9 text-right text-[11px]">
                        {example.length}/{OPENING_EXAMPLE_MAX}
                      </p>
                    </div>
                  ))}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled || atCap}
                      onClick={() => setExamples([...openingExamples, ''])}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" /> Add an example
                    </Button>
                    {questionnaireId && versionId && (
                      <OpeningExamplesSuggest
                        questionnaireId={questionnaireId}
                        versionId={versionId}
                        addedTexts={addedTexts}
                        onAdd={addExample}
                        disabled={disabled}
                        atCap={suggestAtCap}
                      />
                    )}
                    <span className="text-muted-foreground ml-auto text-xs">
                      {openingExamples.length} of {MAX_OPENING_EXAMPLES}
                    </span>
                  </div>

                  {/* The mode is on but inert. Says so plainly rather than letting the admin believe
                      they have steered something. Matches `usesGuidedOpening()`, which is what the
                      runtime actually checks. */}
                  {!usesGuidedOpening(value) && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      No examples written yet, so the interviewer will still choose its own opening.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Switch
                checked={value.probeDepth}
                onCheckedChange={(probeDepth) => patch({ probeDepth })}
                disabled={disabled}
                aria-label="Probe for depth"
              />
              <Label className="text-sm font-medium">
                Probe for depth{' '}
                <FieldHelp title="Probe for depth">
                  Adds a <strong>PROBE FOR DEPTH</strong> clause on top of the approach: if the last
                  answer was shallow or vague, ask ONE brief follow-up (“What makes you say that?”,
                  “Can you give an example?”) before moving on to anything new. Deepens qualitative
                  answers at the cost of a few more turns. Combines with any approach.
                </FieldHelp>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={value.reflect}
                onCheckedChange={(reflect) => patch({ reflect })}
                disabled={disabled}
                aria-label="Reflect and confirm"
              />
              <Label className="text-sm font-medium">
                Reflect &amp; confirm{' '}
                <FieldHelp title="Reflect & confirm">
                  Adds a <strong>REFLECT AND CONFIRM</strong> clause: before the next question,
                  briefly play back the gist of the last answer in one short <em>statement</em> (“So
                  the backdrop most of the time is sadness.”) — not a verbatim repeat, and never a
                  confirming question like “is that right?”, so the turn still asks only one thing.
                  Builds trust and strengthens answer confidence through corroboration.
                </FieldHelp>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={value.batchRelated}
                onCheckedChange={(batchRelated) => patch({ batchRelated })}
                disabled={disabled}
                aria-label="Batch related questions"
              />
              <Label className="text-sm font-medium">
                Batch related questions{' '}
                <FieldHelp title="Batch related questions">
                  Adds a <strong>BATCH RELATED</strong> clause: when several remaining gaps are
                  closely related, the interviewer MAY invite two or three together in one natural
                  question — the one allowed exception to the default “one thing at a time” rule.
                  Faster and more conversational; slightly harder to extract cleanly.
                </FieldHelp>
              </Label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
