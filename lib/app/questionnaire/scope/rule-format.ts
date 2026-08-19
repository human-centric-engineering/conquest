/**
 * Adaptive Scope (P17) — rendering a hard rule as a plain sentence.
 *
 * One implementation, shared by the Questionnaire Pack's Adaptive scope section and the scope
 * evaluation judges' prompt (F17.21): a rule is stored as an operator/operand pair addressed by
 * key, and both a stakeholder reading the pack and a judge reading the authored config need it read
 * back as English, resolving the topic/data-slot keys to their authored names. Promoted out of
 * `export/build-pack-model.ts`, which was its only reader before the judges needed the same
 * sentence — two copies would have been two answers to "what does this rule say".
 *
 * Pure: no Prisma, no Next.
 */

import {
  SCOPE_RULE_ACTION_LABELS,
  SCOPE_RULE_OPERATOR_LABELS,
  VALUELESS_SCOPE_OPERATORS,
  type ScopeRule,
} from '@/lib/app/questionnaire/scope/types';

/**
 * Render one hard rule as a plain sentence, resolving its topic/data-slot keys to their authored
 * names so a reader never has to read a key. An unresolved key (a rule pointing at a topic or slot
 * since deleted — silently skipped everywhere else in this feature, per
 * `.context/app/questionnaire/adaptive-scope.md`) falls back to the raw key rather than dropping the
 * rule, so a stale rule is still visible as *something* an admin should clean up.
 */
export function describeScopeRule(
  rule: ScopeRule,
  topicLabels: ReadonlyMap<string, string>,
  dataSlotLabels: ReadonlyMap<string, string>
): string {
  const topicLabel = topicLabels.get(rule.topicKey) ?? rule.topicKey;
  const slotLabel = dataSlotLabels.get(rule.dataSlotKey) ?? rule.dataSlotKey;
  const operator = SCOPE_RULE_OPERATOR_LABELS[rule.operator];
  const clause = (VALUELESS_SCOPE_OPERATORS as readonly string[]).includes(rule.operator)
    ? `"${slotLabel}" ${operator}`
    : `"${slotLabel}" ${operator} "${rule.value ?? ''}"`;
  const action = SCOPE_RULE_ACTION_LABELS[rule.action];
  const capitalizedAction = action.charAt(0).toUpperCase() + action.slice(1);
  return `${capitalizedAction} "${topicLabel}" when ${clause}.`;
}
