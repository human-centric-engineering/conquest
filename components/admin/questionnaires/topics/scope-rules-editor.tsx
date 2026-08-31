'use client';

/**
 * The hard-rule list — the handful of cases an author is certain about, checked before the agent.
 *
 * Deliberately a flat list, not a boolean tree: rules exist to hard-pin certainties, and a flat
 * list is legible at a glance in a way nested AND/OR is not. Anything richer is what a topic's
 * plain-English criteria are for.
 *
 * Two behaviours the copy here has to convey, because getting them wrong changes what a respondent
 * is asked: **every match applies** (not first-match-wins — include and exclude are independent
 * assertions about different topics), and **exclude beats include** (an author's "never" is a line
 * drawn, and a second rule they forgot must not cross it).
 *
 * ## Rules depend on data slots, and the surface says so
 *
 * Every rule tests ONE data slot, so a version with none cannot carry a rule at all — and this is
 * not a rare edge: no ingest path generates data slots, so a freshly uploaded questionnaire is
 * always in this state. The Routing Analyst hits the same wall from the other side (its prompt is
 * told "DATA SLOTS: none. Propose no hard rules"), which means an admin can run the analyst, get no
 * rules, and have nothing on screen explaining why.
 *
 * So the dependency is stated three times over, deliberately: in the section heading above this
 * editor, in the empty state, and by disabling "Add rule" (which would otherwise mint a rule with
 * an empty `dataSlotKey` for the admin to discover and delete).
 */

import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import {
  SCOPE_RULE_ACTIONS,
  SCOPE_RULE_ACTION_LABELS,
  SCOPE_RULE_OPERATORS,
  SCOPE_RULE_OPERATOR_LABELS,
  VALUELESS_SCOPE_OPERATORS,
  type ScopeRule,
  type ScopeRuleAction,
  type ScopeRuleOperator,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';

export interface ScopeRulesEditorProps {
  rules: readonly ScopeRule[];
  onChange: (next: ScopeRule[]) => void;
  /** Conditional topics — the only ones a rule can meaningfully act on. */
  topics: readonly Topic[];
  dataSlots: TopicsPayload['inventory']['dataSlots'];
  disabled?: boolean;
}

export function ScopeRulesEditor({
  rules,
  onChange,
  topics,
  dataSlots,
  disabled = false,
}: ScopeRulesEditorProps) {
  const conditional = topics.filter((t) => t.phase === 'conditional');
  /** A rule tests one data slot, so with none there is nothing a rule could be written against. */
  const hasDataSlots = dataSlots.length > 0;

  const patch = (index: number, next: Partial<ScopeRule>) => {
    onChange(rules.map((r, i) => (i === index ? { ...r, ...next } : r)));
  };

  const add = () => {
    const first = dataSlots[0];
    const topic = conditional[0];
    onChange([
      ...rules,
      {
        id: `rule-${rules.length}-${Date.now()}`,
        dataSlotKey: first?.key ?? '',
        operator: 'exists',
        value: null,
        action: 'include',
        topicKey: topic?.key ?? '',
        ordinal: rules.length,
      },
    ]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <Label className="text-sm font-medium">
          Hard rules{' '}
          <FieldHelp title="Hard rules">
            <strong>
              You build one sentence: when a given answer says X, always ask — or never ask — a
              given topic.
            </strong>
            <br />
            <br />
            For example: <em>when “Licence holder” is “No”, never ask “Compliance audit”.</em> You
            pick the answer from your data slots, pick how to compare it, then pick the topic to
            force in or out.
            <br />
            <br />
            Why you would: normally the agent reads the opening and decides each conditional topic
            for itself, weighing it against that topic’s criteria — so it can go either way. A hard
            rule takes that decision away. If the answer matches, the topic is in or out, every
            time, on every interview.
            <br />
            <br />
            Use one only where you cannot live with the agent judging it: eligibility, compliance, a
            section that must never reach the wrong person. Anything you would want judged case by
            case belongs in that topic’s criteria instead — that is what criteria are for.
            <br />
            <br />
            Most questionnaires need none. If a rule and the agent disagree, the rule wins. If two
            rules disagree about the same topic, <em>never ask</em> wins.
          </FieldHelp>
        </Label>
        {/* Disabled with no data slots: `add()` would mint a rule whose `dataSlotKey` is '', which
            is an invalid rule the admin then has to notice and delete. The empty state below says
            why the button is off rather than leaving it inert and unexplained. */}
        <Button variant="outline" size="sm" onClick={add} disabled={disabled || !hasDataSlots}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Add rule
        </Button>
      </div>

      {rules.length === 0 ? (
        /* The empty state has to teach the FORM, not just report the absence. "No hard rules" on
           its own reads as a setting left at its default; what an admin needs to know is what one
           would look like if they added it, in the shape the editor below actually builds. */
        <div className="text-muted-foreground space-y-1 text-xs">
          <p>
            No hard rules — the agent decides every conditional topic for itself, weighing it
            against that topic’s criteria.
          </p>
          <p>
            Add one to overrule it for a specific answer:{' '}
            <em>when “Licence holder” is “No”, never ask “Compliance audit”.</em>
            {!hasDataSlots &&
              ' You need at least one data slot before you can add one — that is where the answer comes from.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule, index) => {
            const valueless = VALUELESS_SCOPE_OPERATORS.includes(rule.operator);
            return (
              <li
                key={rule.id}
                className="bg-muted/30 flex flex-wrap items-end gap-2 rounded-md border p-2"
              >
                <div className="min-w-[10rem] flex-1 space-y-1">
                  <Label className="text-muted-foreground text-[11px]">When the data slot</Label>
                  <Select
                    value={rule.dataSlotKey}
                    onValueChange={(v) => patch(index, { dataSlotKey: v })}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Pick a data slot" />
                    </SelectTrigger>
                    <SelectContent>
                      {/* A rule may name a slot that has since been deleted. Keep it selectable so
                          the admin can see what the findings above are complaining about. */}
                      {!dataSlots.some((d) => d.key === rule.dataSlotKey) &&
                        rule.dataSlotKey.length > 0 && (
                          <SelectItem value={rule.dataSlotKey}>
                            {rule.dataSlotKey} (missing)
                          </SelectItem>
                        )}
                      {dataSlots.map((slot) => (
                        <SelectItem key={slot.key} value={slot.key}>
                          {slot.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="w-36 space-y-1">
                  <Label className="text-muted-foreground text-[11px]">…</Label>
                  <Select
                    value={rule.operator}
                    onValueChange={(v) =>
                      patch(index, {
                        operator: v as ScopeRuleOperator,
                        // Clear the operand when switching to an operator that ignores it, so a
                        // stale value can never look like it is still being compared.
                        ...(VALUELESS_SCOPE_OPERATORS.includes(v as ScopeRuleOperator)
                          ? { value: null }
                          : {}),
                      })
                    }
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCOPE_RULE_OPERATORS.map((op) => (
                        <SelectItem key={op} value={op}>
                          {SCOPE_RULE_OPERATOR_LABELS[op]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {!valueless && (
                  <div className="w-40 space-y-1">
                    <Label className="text-muted-foreground text-[11px]">this value</Label>
                    <Input
                      value={rule.value ?? ''}
                      onChange={(e) => patch(index, { value: e.target.value })}
                      className="h-8 text-xs"
                      disabled={disabled}
                    />
                  </div>
                )}

                <div className="w-36 space-y-1">
                  <Label className="text-muted-foreground text-[11px]">then</Label>
                  <Select
                    value={rule.action}
                    onValueChange={(v) => patch(index, { action: v as ScopeRuleAction })}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCOPE_RULE_ACTIONS.map((action) => (
                        <SelectItem key={action} value={action}>
                          {SCOPE_RULE_ACTION_LABELS[action]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="min-w-[10rem] flex-1 space-y-1">
                  <Label className="text-muted-foreground text-[11px]">the topic</Label>
                  <Select
                    value={rule.topicKey}
                    onValueChange={(v) => patch(index, { topicKey: v })}
                    disabled={disabled}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Pick a topic" />
                    </SelectTrigger>
                    <SelectContent>
                      {!conditional.some((t) => t.key === rule.topicKey) &&
                        rule.topicKey.length > 0 && (
                          <SelectItem value={rule.topicKey}>{rule.topicKey} (missing)</SelectItem>
                        )}
                      {conditional.map((topic) => (
                        <SelectItem key={topic.key} value={topic.key}>
                          {topic.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive h-8 w-8"
                  aria-label="Remove rule"
                  onClick={() => onChange(rules.filter((_, i) => i !== index))}
                  disabled={disabled}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
