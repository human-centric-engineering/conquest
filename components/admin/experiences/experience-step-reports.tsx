'use client';

/**
 * The Reports tab of an experience workspace (F15.4).
 *
 * Lists the journey's steps and renders the cohort-report panel for the selected one. Reports are
 * scoped PER STEP, and this surface is where that becomes visible to an author: each step ran a
 * different questionnaire, so each has its own respondents, its own questions and its own report.
 *
 * There is deliberately no "whole experience" option here. Different steps run different
 * questionnaire versions whose data-slot rows are distinct, so a single cross-step aggregation
 * would silently drop every fill that did not belong to the version it happened to key on — a
 * confident report over a fraction of the data. An experience-wide view has to be a synthesis over
 * ready step reports, which is its own piece of work.
 */

import { useState } from 'react';

import { CohortReportPanel } from '@/components/admin/cohorts/cohort-report-panel';
import { stepReportApi } from '@/components/admin/cohorts/report-api';
import { cn } from '@/lib/utils';

export interface StepReportTarget {
  stepId: string;
  key: string;
  title: string;
  /** The questionnaire behind the step, or null when none is attached / it no longer resolves. */
  questionnaireTitle: string | null;
  /** False when the step has no questionnaire — there is nothing to report on. */
  reportable: boolean;
}

export interface ExperienceStepReportsProps {
  experienceId: string;
  steps: StepReportTarget[];
}

export function ExperienceStepReports({ experienceId, steps }: ExperienceStepReportsProps) {
  const reportable = steps.filter((s) => s.reportable);
  const [selectedId, setSelectedId] = useState<string | null>(reportable[0]?.stepId ?? null);

  if (reportable.length === 0) {
    return (
      <p className="text-muted-foreground rounded-xl border p-6 text-sm">
        No step has a questionnaire attached yet. Add one on the Steps tab — a report is generated
        over the people who answered a step, so there is nothing to analyse until then.
      </p>
    );
  }

  const selected = reportable.find((s) => s.stepId === selectedId) ?? reportable[0];

  return (
    <div className="space-y-4">
      {/* Step selector. Rendered even for a single step so the surface always states WHICH step
          the report below covers — the per-step scoping is the thing most likely to be
          misread as "the whole journey". */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Steps">
        {reportable.map((step) => {
          const active = step.stepId === selected.stepId;
          return (
            <button
              key={step.stepId}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelectedId(step.stepId)}
              className={cn(
                'rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                active ? 'bg-accent border-foreground/20' : 'hover:bg-accent/50'
              )}
            >
              <span className="block font-medium">{step.title}</span>
              <span className="text-muted-foreground block text-xs">
                {step.questionnaireTitle ?? 'Questionnaire missing'}
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-muted-foreground text-sm">
        Covering everyone who answered <span className="font-medium">{selected.title}</span> as part
        of this experience — not the questionnaire&apos;s other respondents.
      </p>

      {/* `key` forces a fresh panel per step: the panel holds the loaded view and revision state
          internally, and reusing the instance across steps would show one step's report under
          another's heading until its refetch landed. */}
      <CohortReportPanel key={selected.stepId} api={stepReportApi(experienceId, selected.stepId)} />
    </div>
  );
}
