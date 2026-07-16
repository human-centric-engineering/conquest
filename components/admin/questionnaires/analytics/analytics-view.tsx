'use client';

/**
 * F8.1 analytics client island.
 *
 * Renders the shared filter, then the three analytics surfaces in tabs. The version
 * selection and SSR data fetch live in the page; this component is presentational +
 * URL-driven filtering only (no per-row fetches).
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AnalyticsFilters,
  type AnalyticsRoundChoice,
} from '@/components/admin/questionnaires/analytics/analytics-filters';
import { QuestionDistributionPanel } from '@/components/admin/questionnaires/analytics/question-distribution-panel';
import { CompletionFunnelPanel } from '@/components/admin/questionnaires/analytics/completion-funnel-panel';
import { CostPanel } from '@/components/admin/questionnaires/analytics/cost-panel';
import {
  ALPHA_ANALYTICS_ANONYMITY_DISABLED,
  K_ANONYMITY_THRESHOLD,
} from '@/lib/app/questionnaire/analytics/privacy';
import type { TagView } from '@/lib/app/questionnaire/views';
import type {
  CompletionFunnelResult,
  QuestionDistributionsResult,
  QuestionnaireCostResult,
} from '@/lib/app/questionnaire/analytics';

export interface AnalyticsViewProps {
  tagVocabulary: TagView[];
  distributions: QuestionDistributionsResult | null;
  funnel: CompletionFunnelResult | null;
  cost: QuestionnaireCostResult | null;
  filters: { from: string; to: string; tagIds: string[]; roundId?: string };
  /** Round-scope options for the filter; empty hides the selector. */
  roundOptions: AnalyticsRoundChoice[];
  hasOpenEnded: boolean;
}

export function AnalyticsView({
  tagVocabulary,
  distributions,
  funnel,
  cost,
  filters,
  roundOptions,
  hasOpenEnded,
}: AnalyticsViewProps) {
  return (
    <div className="space-y-6">
      <AnalyticsFilters
        tagVocabulary={tagVocabulary}
        filters={filters}
        roundOptions={roundOptions}
        hasOpenEnded={hasOpenEnded}
      />

      {ALPHA_ANALYTICS_ANONYMITY_DISABLED && (
        <div
          role="note"
          className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <strong>Alpha:</strong> respondent-privacy suppression is temporarily disabled for alpha
          testing, so analytics for small cohorts (fewer than {K_ANONYMITY_THRESHOLD} respondents)
          are shown here even though they would normally be withheld. This protection returns
          automatically when the product leaves alpha.
        </div>
      )}

      <Tabs defaultValue="distributions">
        <TabsList>
          <TabsTrigger value="distributions">Distributions</TabsTrigger>
          <TabsTrigger value="funnel">Completion funnel</TabsTrigger>
          <TabsTrigger value="cost">Cost</TabsTrigger>
        </TabsList>
        <TabsContent value="distributions" className="mt-4">
          <QuestionDistributionPanel data={distributions} />
        </TabsContent>
        <TabsContent value="funnel" className="mt-4">
          <CompletionFunnelPanel data={funnel} />
        </TabsContent>
        <TabsContent value="cost" className="mt-4">
          <CostPanel data={cost} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
