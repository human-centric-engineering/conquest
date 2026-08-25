/**
 * What a card on the Check tab says when it has nothing to show.
 *
 * Before the sub-tab split (F17.26) these cards returned `null` and that was fine — they were two
 * of a dozen on one long page, so vanishing was invisible. On a tab of their own, silence reads as
 * a page that failed to load. Each empty state names the ONE thing that would fill it, so the tab
 * is still an instruction when it is not yet a report.
 */

import { Card, CardContent } from '@/components/ui/card';

export interface ScopeEmptyStateProps {
  title: string;
  body: string;
}

export function ScopeEmptyState({ title, body }: ScopeEmptyStateProps) {
  return (
    <Card>
      <CardContent className="p-6 text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground mx-auto mt-1 max-w-prose text-sm leading-relaxed">
          {body}
        </p>
      </CardContent>
    </Card>
  );
}
