/**
 * ProvenanceBadge — how an answer arrived (F7.2).
 *
 * Maps the answer's provenance label to quiet respondent-facing copy. `refined` is
 * the only label the conversation produces by re-asking (F4.4), so it reads
 * distinctly; `direct` is the plain "you told us" case and stays the most muted.
 *
 * `// DEMO-ONLY (F7.2):` the provenance vocabulary is questionnaire-domain.
 */

import { Badge } from '@/components/ui/badge';
import type { AnswerProvenance } from '@/lib/app/questionnaire/types';

const PROVENANCE_LABELS: Record<AnswerProvenance, string> = {
  direct: 'You said',
  inferred: 'Inferred',
  synthesised: 'Synthesised',
  refined: 'Refined',
};

export interface ProvenanceBadgeProps {
  provenance: AnswerProvenance | null;
  className?: string;
}

export function ProvenanceBadge({ provenance, className }: ProvenanceBadgeProps) {
  if (provenance === null) return null;
  return (
    <Badge variant="outline" className={className}>
      {PROVENANCE_LABELS[provenance]}
    </Badge>
  );
}
