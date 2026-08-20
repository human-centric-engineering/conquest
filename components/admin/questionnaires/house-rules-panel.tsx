'use client';

/**
 * Editor for the "Interviewer house rules" group on the Settings tab.
 *
 * Lives in its own file rather than inside `config-editor.tsx` because that file is already ~2900
 * lines and a rule list is a real sub-editor, not a field.
 *
 * Three deliberate choices:
 *
 *  - **Typed rules, not a textarea.** Each kind renders into its own labelled prompt sub-block, and
 *    a structured list is what lets the conflict lints reason about what an admin wrote. A blob
 *    would also invite quietly overriding the safeguarding and reply-format rules the prompt needs.
 *  - **Reorder with buttons, not drag-and-drop.** Order only affects listing within a sub-block, so
 *    the interaction cost of a DnD dependency buys nothing here.
 *  - **A preview of the real rendered block.** `buildHouseRulesInstructions` is pure and shared with
 *    the server, so what the admin reads here is byte-for-byte what the interviewer is sent — not an
 *    approximation that can drift.
 *
 * @see lib/app/questionnaire/chat/house-rules.ts — the renderer this previews
 * @see .context/app/questionnaire/interviewer-house-rules.md
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, Lightbulb, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
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
import { HouseRulesLibrary } from '@/components/admin/questionnaires/house-rules-library';
import { HouseRulesSuggest } from '@/components/admin/questionnaires/house-rules-suggest';
import { cn } from '@/lib/utils';
import {
  buildHouseRulesInstructions,
  narrowHouseRules,
} from '@/lib/app/questionnaire/chat/house-rules';
import {
  HOUSE_RULE_PLACEHOLDER,
  HOUSE_RULE_PRESETS,
  type HouseRulePreset,
} from '@/lib/app/questionnaire/house-rules/presets';
import {
  HOUSE_RULE_KINDS,
  HOUSE_RULE_KIND_LABELS,
  HOUSE_RULE_TEXT_MAX,
  HOUSE_RULE_TRIGGER_MAX,
  MAX_HOUSE_RULES,
  type HouseRule,
  type HouseRuleKind,
  type HouseRulesSettings,
} from '@/lib/app/questionnaire/types';

/** Kind chip colours — shared with the library dialog so the two surfaces read as one system. */
const KIND_ACCENT: Record<HouseRuleKind, string> = {
  always: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  never: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  if_asked: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

/** Per-kind prompt for the text field — "the answer to give" reads very differently from "do this". */
const TEXT_LABEL: Record<HouseRuleKind, string> = {
  always: 'What the interviewer should always do',
  never: 'What the interviewer should never do',
  if_asked: 'What to say',
};

const TEXT_PLACEHOLDER: Record<HouseRuleKind, string> = {
  always: 'Ask for a concrete recent example when an answer stays general.',
  never: 'Give advice or recommend a course of action.',
  if_asked: 'Only the research team, and results are reported grouped.',
};

/**
 * A fresh id that cannot collide with anything already stored. Ids must be unique (the server
 * rejects duplicates) and stored rules may carry positional ids like `rule-2` from the read-path
 * narrower, so a naive counter is not safe — check against what is actually in the list.
 */
function freshId(existing: ReadonlyArray<HouseRule>): string {
  const taken = new Set(existing.map((rule) => rule.id));
  let n = existing.length + 1;
  while (taken.has(`hr-${n}`)) n += 1;
  return `hr-${n}`;
}

export function HouseRulesPanel({
  value,
  onChange,
  disabled,
  questionnaireId,
  versionId,
}: {
  value: HouseRulesSettings;
  onChange: (next: HouseRulesSettings) => void;
  disabled?: boolean;
  /**
   * Ids for the suggest route. Optional so the panel still renders standalone (and in tests)
   * without one — the AI affordance simply doesn't appear, and every other control still works.
   */
  questionnaireId?: string;
  versionId?: string;
}) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const { enabled, rules } = value;
  const setRules = (next: HouseRule[]) => onChange({ ...value, rules: next });

  const patchRule = (id: string, patch: Partial<HouseRule>) =>
    setRules(
      rules.map((rule) => {
        if (rule.id !== id) return rule;
        const next = { ...rule, ...patch };
        // A kind change away from `if_asked` must drop the trigger — the server rejects a trigger on
        // any other kind, and the read-path narrower strips strays. Keep all three in agreement.
        if (next.kind !== 'if_asked') delete next.trigger;
        else if (next.trigger === undefined) next.trigger = '';
        return next;
      })
    );

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    setRules(next);
  };

  const addRule = (partial: Pick<HouseRule, 'kind' | 'text'> & { trigger?: string }) =>
    setRules([...rules, { id: freshId(rules), enabled: true, ...partial }]);

  const addPreset = (preset: HouseRulePreset) =>
    addRule({
      kind: preset.kind,
      text: preset.text,
      ...(preset.trigger ? { trigger: preset.trigger } : {}),
    });

  // Which library presets are already in the list. Matched on the preset's original text, so an
  // inserted-then-edited copy stops counting as "added" once the admin has genuinely rewritten it —
  // at which point offering it again is the right call, not a duplicate.
  const addedTexts = useMemo<ReadonlySet<string>>(
    () => new Set(rules.map((rule) => rule.text)),
    [rules]
  );
  const addedKeys = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        HOUSE_RULE_PRESETS.filter((preset) => addedTexts.has(preset.text)).map(
          (preset) => preset.key
        )
      ),
    [addedTexts]
  );

  // Narrow before rendering, exactly as the server does on the way out of the database. Without
  // this the preview would show the admin's raw text while the live turn shows the narrowed form —
  // and a preview that differs from what is actually sent is worse than no preview.
  const preview = useMemo(() => buildHouseRulesInstructions(narrowHouseRules(value)), [value]);
  const atCap = rules.length >= MAX_HOUSE_RULES;
  const unfilled = rules.filter(
    (rule) => rule.enabled && rule.text.includes(HOUSE_RULE_PLACEHOLDER)
  ).length;
  // Rules the save will discard: no text, or an `if_asked` rule with nothing to react to. The save
  // drops them rather than failing validation with a path error the admin cannot act on — but
  // dropping them silently would lose real wording, so say so before they hit Save.
  const incomplete = rules.filter(
    (rule) => !rule.text.trim() || (rule.kind === 'if_asked' && !(rule.trigger ?? '').trim())
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={(next) => onChange({ ...value, enabled: next })}
          disabled={disabled}
          aria-label="Add house rules for this questionnaire"
        />
        <Label className="text-sm font-medium">
          Add house rules for this questionnaire{' '}
          <FieldHelp title="House rules">
            <p>
              Rules about what the interviewer <strong>may and may not do</strong> — as opposed to
              how it sounds (that&rsquo;s tone) or how it questions (that&rsquo;s strategy).
            </p>
            <p className="mt-2">
              They apply to every turn and to the closing message. They sit below the built-in
              safety and formatting rules, so a rule can never make the interviewer ask two
              questions at once, break the reply format, or override safeguarding.
            </p>
            <p className="mt-2">
              Off means no rules are sent at all and nothing about the conversation changes.
            </p>
          </FieldHelp>
        </Label>
      </div>

      {enabled && (
        <div className="border-border/60 ml-1 space-y-3 border-l pl-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || atCap}
              onClick={() => addRule({ kind: 'always', text: '' })}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add a rule
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || atCap}
              onClick={() => setLibraryOpen(true)}
            >
              <Lightbulb className="mr-1 h-3.5 w-3.5" /> Rule ideas
            </Button>
            {questionnaireId && versionId && (
              <HouseRulesSuggest
                questionnaireId={questionnaireId}
                versionId={versionId}
                addedTexts={addedTexts}
                onAdd={(suggestion) =>
                  addRule({
                    kind: suggestion.kind,
                    text: suggestion.text,
                    ...(suggestion.trigger ? { trigger: suggestion.trigger } : {}),
                  })
                }
                disabled={disabled}
                atCap={atCap}
              />
            )}
            {rules.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPreviewOpen((o) => !o)}
              >
                <Eye className="mr-1 h-3.5 w-3.5" />
                {previewOpen ? 'Hide' : 'Show'} what the interviewer sees
              </Button>
            )}
            <span className="text-muted-foreground ml-auto text-xs">
              {rules.length} of {MAX_HOUSE_RULES}
            </span>
          </div>

          {rules.length === 0 && (
            <p className="text-muted-foreground text-xs">
              No rules yet. <strong>Rule ideas</strong> has ready-written ones grouped by what they
              solve — staying on topic, questions respondents ask, getting useful detail, and so on.
            </p>
          )}

          {incomplete > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {incomplete === 1 ? 'One rule is' : `${incomplete} rules are`} unfinished and
              won&rsquo;t be saved — an &ldquo;if asked&rdquo; rule needs both what they ask about
              and what to say.
            </p>
          )}

          {unfilled > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {unfilled === 1 ? 'One rule still has' : `${unfilled} rules still have`} a{' '}
              <code className="text-[11px]">{HOUSE_RULE_PLACEHOLDER}</code> to fill in — the
              interviewer will say it literally if you leave it.
            </p>
          )}

          <div className="space-y-2">
            {rules.map((rule, index) => (
              <div key={rule.id} className="bg-card space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={rule.kind}
                    onValueChange={(v) => patchRule(rule.id, { kind: v as HouseRuleKind })}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-8 w-[9.5rem] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HOUSE_RULE_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {HOUSE_RULE_KIND_LABELS[kind]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Badge
                    variant="secondary"
                    className={cn('text-[10px] font-medium', KIND_ACCENT[rule.kind])}
                  >
                    {HOUSE_RULE_KIND_LABELS[rule.kind]}
                  </Badge>

                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Move up"
                      disabled={disabled || index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Move down"
                      disabled={disabled || index === rules.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                    {/* Individually switchable so an admin can park a rule without losing its
                        wording — drafting and shipping are different decisions. */}
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(next) => patchRule(rule.id, { enabled: next })}
                      disabled={disabled}
                      aria-label="Use this rule"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive h-7 w-7"
                      aria-label="Remove rule"
                      disabled={disabled}
                      onClick={() => setRules(rules.filter((r) => r.id !== rule.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {rule.kind === 'if_asked' && (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">
                      When the respondent asks about{' '}
                      <FieldHelp title="What the respondent asks about">
                        <p>
                          Describe the subject in plain words — &ldquo;who will see their
                          answers&rdquo;, &ldquo;how long this takes&rdquo;. The interviewer matches
                          on meaning, so it doesn&rsquo;t need the exact phrasing someone might use.
                        </p>
                      </FieldHelp>
                    </Label>
                    <Input
                      value={rule.trigger ?? ''}
                      maxLength={HOUSE_RULE_TRIGGER_MAX}
                      placeholder="who will see their answers"
                      disabled={disabled}
                      onChange={(e) => patchRule(rule.id, { trigger: e.target.value })}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {TEXT_LABEL[rule.kind]}{' '}
                    <FieldHelp title="Writing a good rule">
                      <p>Rules work best when each one is a single, checkable instruction.</p>
                      <ul className="mt-2 list-disc space-y-1.5 pl-4">
                        <li>
                          <strong>One instruction per rule.</strong> Split &ldquo;be warm and always
                          get an example&rdquo; into two.
                        </li>
                        <li>
                          <strong>Describe behaviour, not a mood.</strong> &ldquo;Ask for a recent
                          example&rdquo; works; &ldquo;be more insightful&rdquo; doesn&rsquo;t.
                        </li>
                        <li>
                          <strong>Say what to do instead</strong> where you can — a
                          &ldquo;never&rdquo; on its own leaves the interviewer guessing.
                        </li>
                        <li>
                          <strong>Don&rsquo;t restate other settings.</strong> Tone, question order,
                          scoring and report content are controlled elsewhere and a rule here
                          won&rsquo;t change them.
                        </li>
                      </ul>
                      {rule.kind === 'if_asked' && (
                        <p className="mt-2">
                          The interviewer answers <em>in its own words</em> along these lines rather
                          than reading this out, and never raises it unprompted.
                        </p>
                      )}
                    </FieldHelp>
                  </Label>
                  <Textarea
                    value={rule.text}
                    maxLength={HOUSE_RULE_TEXT_MAX}
                    rows={2}
                    placeholder={TEXT_PLACEHOLDER[rule.kind]}
                    disabled={disabled}
                    onChange={(e) => patchRule(rule.id, { text: e.target.value })}
                  />
                  <p className="text-muted-foreground text-right text-[11px]">
                    {rule.text.length}/{HOUSE_RULE_TEXT_MAX}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {previewOpen && (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs">
                Sent to the interviewer with every question and with the closing message:
              </p>
              <pre className="bg-muted/50 max-h-64 overflow-auto rounded-md border p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
                {preview || 'Nothing — no rules are switched on.'}
              </pre>
            </div>
          )}
        </div>
      )}

      <HouseRulesLibrary
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        addedKeys={addedKeys}
        onAdd={addPreset}
        disabled={disabled || atCap}
      />
    </div>
  );
}
