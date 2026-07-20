'use client';

/**
 * The deterministic routing rules editor.
 *
 * Rules are evaluated in order BEFORE the AI selector, and the first match wins — so the ordering
 * is the author's precedence, and the panel presents it that way ("if none of these match, the AI
 * decides"). A rule whose target step has since been deleted is flagged rather than silently
 * skipped, because silence is exactly what lets that mistake survive.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Plus, Trash2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
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
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  ROUTING_RULE_OPERATOR_LABELS,
  ROUTING_RULE_OPERATORS,
  VALUELESS_OPERATORS,
  type RoutingRuleOperator,
} from '@/lib/app/questionnaire/experiences/routing/types';
import type { ExperienceStepView } from '@/lib/app/questionnaire/experiences/views';

/** A rule as the list endpoint returns it — the stored row plus the dangling flag. */
export interface RoutingRuleRow {
  id: string;
  dataSlotKey: string;
  operator: string;
  value: string | null;
  targetStepKey: string;
  ordinal: number;
  dangling: boolean;
}

export interface RoutingRulesPanelProps {
  experienceId: string;
  rules: RoutingRuleRow[];
  /** Branch steps with a questionnaire attached — the only valid rule targets. */
  candidates: readonly ExperienceStepView[];
  /** Data-slot keys across the entry step's questionnaire, for the key picker's suggestions. */
  slotKeys: string[];
}

const EMPTY_DRAFT = {
  dataSlotKey: '',
  operator: 'equals' as RoutingRuleOperator,
  value: '',
  targetStepKey: '',
};

export function RoutingRulesPanel({
  experienceId,
  rules,
  candidates,
  slotKeys,
}: RoutingRulesPanelProps) {
  const router = useRouter();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsValue = !VALUELESS_OPERATORS.includes(draft.operator);
  const canAdd =
    draft.dataSlotKey.trim() !== '' &&
    draft.targetStepKey !== '' &&
    (!needsValue || draft.value.trim() !== '');

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(API.APP.EXPERIENCES.routingRules(experienceId), {
        body: {
          dataSlotKey: draft.dataSlotKey.trim(),
          operator: draft.operator,
          value: needsValue ? draft.value.trim() : null,
          targetStepKey: draft.targetStepKey,
        },
      });
      setDraft(EMPTY_DRAFT);
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not add that rule.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ruleId: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.delete(API.APP.EXPERIENCES.routingRule(experienceId, ruleId));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not delete that rule.');
    } finally {
      setBusy(false);
    }
  };

  if (candidates.length === 0) {
    return (
      <p className="text-muted-foreground rounded-xl border p-6 text-sm">
        Add branch steps with questionnaires attached before writing routing rules — a rule needs
        somewhere to route to.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="flex items-center gap-1 text-lg font-medium">
          Routing rules
          <FieldHelp title="Deterministic rules">
            <p>
              Rules are checked in order, before the AI selector. The first one that matches decides
              the route, and the AI is never asked.
            </p>
            <p className="mt-2">
              Use them for the cases you are certain about — &ldquo;more than 500 staff always goes
              to the enterprise follow-up&rdquo;. Leave everything else to the selector.
            </p>
          </FieldHelp>
        </h2>
        <p className="text-muted-foreground text-sm">
          Checked top to bottom. If none match, the AI selector decides.
        </p>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      {rules.length > 0 && (
        <ol className="space-y-2">
          {rules.map((rule, index) => (
            <li
              key={rule.id}
              className="bg-card flex items-center justify-between gap-3 rounded-xl border p-3"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                <span className="text-muted-foreground">If</span>
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{rule.dataSlotKey}</code>
                <span className="text-muted-foreground">
                  {
                    ROUTING_RULE_OPERATOR_LABELS[
                      narrowToEnum(rule.operator, ROUTING_RULE_OPERATORS, 'equals')
                    ]
                  }
                </span>
                {rule.value !== null && (
                  <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{rule.value}</code>
                )}
                <span className="text-muted-foreground">→</span>
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{rule.targetStepKey}</code>
                {rule.dangling && (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    That step no longer exists — this rule never fires
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive h-8 w-8 shrink-0"
                disabled={busy}
                onClick={() => void remove(rule.id)}
                aria-label="Delete rule"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ol>
      )}

      <div className="bg-card space-y-3 rounded-xl border p-4">
        <p className="text-sm font-medium">Add a rule</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rule-slot" className="flex items-center gap-1 text-xs">
              If this answer
              <FieldHelp title="Which answer to test">
                The data-slot key from the questionnaire the respondent just finished. Data slots
                are the stable names for what was learnt, so a rule keeps working even if the
                question wording changes.
              </FieldHelp>
            </Label>
            <Input
              id="rule-slot"
              list="experience-slot-keys"
              value={draft.dataSlotKey}
              onChange={(e) => setDraft({ ...draft, dataSlotKey: e.target.value })}
              placeholder="headcount"
              disabled={busy}
            />
            <datalist id="experience-slot-keys">
              {slotKeys.map((key) => (
                <option key={key} value={key} />
              ))}
            </datalist>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rule-operator" className="text-xs">
              Comparison
            </Label>
            <Select
              value={draft.operator}
              onValueChange={(v) => setDraft({ ...draft, operator: v as RoutingRuleOperator })}
              disabled={busy}
            >
              <SelectTrigger id="rule-operator">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROUTING_RULE_OPERATORS.map((op) => (
                  <SelectItem key={op} value={op}>
                    {ROUTING_RULE_OPERATOR_LABELS[op]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Hidden for `exists`, which tests only for presence — showing an operand field would
              imply a comparison that never happens. */}
          {needsValue && (
            <div className="space-y-1.5">
              <Label htmlFor="rule-value" className="text-xs">
                Value
              </Label>
              <Input
                id="rule-value"
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                placeholder={draft.operator === 'gt' || draft.operator === 'lt' ? '500' : 'yes'}
                disabled={busy}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="rule-target" className="text-xs">
              Then route to
            </Label>
            <Select
              value={draft.targetStepKey}
              onValueChange={(v) => setDraft({ ...draft, targetStepKey: v })}
              disabled={busy}
            >
              <SelectTrigger id="rule-target">
                <SelectValue placeholder="Choose a step…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((step) => (
                  <SelectItem key={step.key} value={step.key}>
                    {step.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button onClick={() => void add()} disabled={busy || !canAdd} size="sm">
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Add rule
        </Button>
      </div>
    </div>
  );
}
