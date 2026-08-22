'use client';

/**
 * Interviewer policy panel (F18.7) — what the configured policy actually did.
 *
 * Three sections, in the order an admin would ask about them: how far the questioning arc got, what
 * happened to the questions marked must-ask, and what behaviour policy was in force.
 *
 * The third is the honest one. There is no per-turn record of a house rule firing, so this panel
 * reports the **configuration** and says so on the card rather than implying a behavioural count it
 * cannot produce. Stating the limit is the point: a number with no basis would be worse than none.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
// The threshold comes from the pure `privacy` leaf, not the barrel — the barrel re-exports the
// Prisma-coupled aggregators, which must never enter this client bundle.
import { K_ANONYMITY_THRESHOLD } from '@/lib/app/questionnaire/analytics/privacy';
import type {
  FunnelPhaseKey,
  InterviewerPolicyResult,
} from '@/lib/app/questionnaire/analytics/views';

const PHASE_LABELS: Record<FunnelPhaseKey, string> = {
  open: 'Stayed broad',
  mixed: 'Narrowed part-way',
  targeted: 'Reached specific questions',
};

const PHASE_ORDER: FunnelPhaseKey[] = ['open', 'mixed', 'targeted'];

function PhaseBar({ label, count, total }: { label: string; count: number; total: number }) {
  const share = total > 0 ? count / total : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {count} {total > 0 && <>· {(share * 100).toFixed(0)}%</>}
        </span>
      </div>
      <div className="bg-muted h-6 w-full overflow-hidden rounded">
        <div
          className="bg-primary/70 h-full rounded"
          style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function InterviewerPolicyPanel({ data }: { data: InterviewerPolicyResult | null }) {
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Interviewer</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">This data could not be loaded.</p>
        </CardContent>
      </Card>
    );
  }

  if (data.suppressed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Interviewer</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {data.sessions === 0
              ? 'No interviews in this period yet.'
              : `Only ${data.sessions} interviews so far — held back until there are at least ${K_ANONYMITY_THRESHOLD}, so no individual can be identified from these counts.`}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {data.findings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Worth a look</CardTitle>
            <CardDescription>
              Observations about how the policy played out, not verdicts — each may be exactly what
              you intended.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {data.findings.map((f, i) => (
                <li key={`${f.code}-${f.questionKey ?? i}`} className="text-sm">
                  {f.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>How far the questioning narrowed</CardTitle>
          <CardDescription>
            {data.arcConfigured
              ? `Across ${data.sessions} interviews, by the furthest point each one reached.`
              : 'This questionnaire does not use the funnel approach, so there is no arc to narrow. Counts are shown for reference.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {PHASE_ORDER.map((phase) => (
            <PhaseBar
              key={phase}
              label={PHASE_LABELS[phase]}
              count={data.furthestPhase[phase]}
              total={data.sessions}
            />
          ))}
          {data.medianTurnsToTargeted !== null && (
            <p className="text-muted-foreground text-sm">
              Typically {data.medianTurnsToTargeted} questions in before the interview got specific.
            </p>
          )}
          {data.turnsWithoutPhase > 0 && (
            <p className="text-muted-foreground text-xs">
              {data.turnsWithoutPhase} earlier answers aren’t included — they were recorded before
              this was tracked.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Questions set to be asked as written</CardTitle>
          <CardDescription>
            {!data.fidelityGateOn
              ? 'Asking questions as written is switched off for this questionnaire, so every question is asked conversationally.'
              : data.mustAsk.length === 0
                ? 'No question is set to be asked as written.'
                : 'Whether each one was actually reached, and how often its answer control was shown.'}
          </CardDescription>
        </CardHeader>
        {data.fidelityGateOn && data.mustAsk.length > 0 && (
          <CardContent>
            <ul className="divide-border divide-y">
              {data.mustAsk.map((q) => (
                <li key={q.key} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{q.prompt}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {q.reached === 0 ? 'never reached' : `reached ${q.reached}×`}
                    {q.cardShown > 0 && ` · answer control shown ${q.cardShown}×`}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>House rules</CardTitle>
          <CardDescription>
            {data.houseRulesActive === 0
              ? 'No house rules are switched on for this questionnaire.'
              : `${data.houseRulesActive} rule${data.houseRulesActive === 1 ? '' : 's'} in force for every interview.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/*
           * The honest limit, stated rather than papered over. Each turn's full prompt IS saved, so
           * a rule's presence can be confirmed for any single interview from the Turn Inspector —
           * but counting how often one changed an answer would mean inferring intent from prose,
           * and a number with no basis is worse than none.
           */}
          <p className="text-muted-foreground text-sm">
            How often a rule changed what the interviewer said isn’t counted here — that is a
            judgement about wording, not something that can be measured. To check a specific
            interview, open its transcript.
          </p>
        </CardContent>
      </Card>

      {data.truncated && (
        <p className="text-muted-foreground text-xs">
          This covers the most recent answers in the period, not every one — narrow the date range
          for a complete picture.
        </p>
      )}
    </div>
  );
}
