'use client';

/**
 * The synthesis on a participant's own screen (P15.5).
 *
 * Shown only when the author opted in AND chose to put it on people's own devices — the default is
 * the shared screen alone. Everything reaching this component has already passed the k-anonymity
 * gate AND been individually published by the facilitator, server-side; nothing here decides what
 * is safe to show.
 *
 * ## Why `tab` and `modal` are genuinely different
 *
 * `tab` is quiet: it sits beside the conversation and is there when someone looks for it. `modal`
 * pulls attention — useful when the facilitator wants everyone reading the same thing at the same
 * moment, disruptive to anyone still typing. That is exactly why it is an author's choice and not
 * ours, and why the modal can always be dismissed: a respondent mid-answer must be able to get
 * back to what they were writing.
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  EXPERIENCE_INSIGHT_KIND_LABELS,
  type MeetingInsightView,
} from '@/lib/app/questionnaire/experiences/meeting/types';
import type { ExperienceInsightDisplay } from '@/lib/app/questionnaire/experiences/types';

export interface MeetingInsightPanelProps {
  insights: MeetingInsightView[];
  display: ExperienceInsightDisplay;
}

function InsightList({ insights }: { insights: MeetingInsightView[] }) {
  return (
    <ol className="space-y-3">
      {insights.map((insight) => (
        <li key={insight.id}>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">
            {EXPERIENCE_INSIGHT_KIND_LABELS[insight.kind]}
          </p>
          <p className="mt-0.5 font-medium">{insight.statement}</p>
          {insight.detail && <p className="text-muted-foreground mt-1 text-sm">{insight.detail}</p>}
        </li>
      ))}
    </ol>
  );
}

export function MeetingInsightPanel({ insights, display }: MeetingInsightPanelProps) {
  // Keyed on the newest insight id: when the facilitator publishes something new, a previously
  // dismissed modal should reappear. Dismissing means "not this, now" — not "never again".
  const newest = insights[insights.length - 1]?.id ?? '';
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(null);
  }, [newest]);

  if (display === 'modal' && dismissed !== newest) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="What the room said"
      >
        <div className="bg-card max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 className="font-medium">What the room said</h2>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Close"
              onClick={() => setDismissed(newest)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-4">
            <InsightList insights={insights} />
          </div>
        </div>
      </div>
    );
  }

  if (display === 'modal') return null;

  return (
    <div className="bg-card max-h-64 overflow-y-auto rounded-xl border p-4">
      <h2 className="text-muted-foreground mb-3 text-sm font-medium">What the room said</h2>
      <InsightList insights={insights} />
    </div>
  );
}
