/**
 * VersionGraph (P2 / F2.1a) — read-only render of one version's structural graph.
 *
 * Pure presentational server component: goal + audience (with read-time
 * "inferred" badges) followed by the section → question tree. No interactivity —
 * editing arrives in F2.1b (PR2). Consumes the `VersionGraphView` contract the
 * `GET …/versions/:vid` endpoint returns.
 */

import { Target } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { AUDIENCE_FIELDS, QUESTION_TYPE_LABELS } from '@/lib/app/questionnaire/types';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';

import {
  QuestionConfigWarning,
  QUESTION_ISSUE_RING,
} from '@/components/admin/questionnaires/question-config-warning';
import { TagChip } from '@/components/admin/questionnaires/tag-chip';
import { questionConfigIssue } from '@/lib/app/questionnaire/authoring';

const AUDIENCE_FIELD_LABEL: Record<(typeof AUDIENCE_FIELDS)[number], string> = {
  description: 'Description',
  role: 'Role',
  expertiseLevel: 'Expertise level',
  estimatedDurationMinutes: 'Est. duration (min)',
  locale: 'Locale',
  sensitivity: 'Sensitivity',
  notes: 'Notes',
};

function InferredBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--cq-accent-ring)] bg-[var(--cq-accent-muted)] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--cq-accent)] uppercase">
      inferred
    </span>
  );
}

export function VersionGraph({ graph }: { graph: VersionGraphView }) {
  const audienceEntries = graph.audience
    ? // `!= null` excludes both absent (undefined) and explicit JSON-null fields —
      // a null would otherwise render as the literal string "null" via String().
      AUDIENCE_FIELDS.filter((f) => graph.audience?.[f] != null).map((f) => ({
        label: AUDIENCE_FIELD_LABEL[f],
        value: String(graph.audience?.[f]),
        inferred: graph.audienceProvenance?.[f] === 'inferred',
      }))
    : [];

  return (
    <div className="space-y-6">
      {/* Goal + audience */}
      <section className="cq-rise bg-card relative overflow-hidden rounded-xl border shadow-sm">
        {/* Goal hero band — amber accent + faint blueprint grid, echoing the editor's drafting motif. */}
        <div className="relative border-b bg-[var(--cq-accent-muted)] p-5">
          <div
            className="cq-blueprint pointer-events-none absolute inset-0 opacity-40"
            aria-hidden
          />
          <div className="relative flex items-start gap-3.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--cq-accent)] text-[var(--cq-accent-foreground)] shadow-sm">
              <Target className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1.5">
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-semibold tracking-[0.18em] text-[var(--cq-accent)] uppercase">
                  Goal
                </p>
                {graph.goalProvenance === 'inferred' && <InferredBadge />}
              </div>
              <p className="text-foreground text-base leading-snug font-medium text-balance">
                {graph.goal ?? (
                  <span className="text-muted-foreground font-normal italic">Not set</span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Audience + tags */}
        <div className="space-y-5 p-5">
          <div>
            <h3 className="text-muted-foreground mb-2.5 text-[10px] font-semibold tracking-[0.18em] uppercase">
              Audience
            </h3>
            {audienceEntries.length > 0 ? (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {audienceEntries.map((e) => (
                  <div
                    key={e.label}
                    className="flex flex-col gap-0.5 border-l-2 border-[var(--cq-accent-muted)] pl-3"
                  >
                    <dt className="text-muted-foreground text-xs">{e.label}</dt>
                    <dd className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {e.value}
                      {e.inferred && <InferredBadge />}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-muted-foreground text-sm italic">Not set</p>
            )}
          </div>
          {graph.tags.length > 0 && (
            <div>
              <h3 className="text-muted-foreground mb-2.5 text-[10px] font-semibold tracking-[0.18em] uppercase">
                Tags
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {graph.tags.map((t) => (
                  <TagChip key={t.id} tag={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Sections → questions */}
      {graph.sections.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">This version has no sections.</p>
      ) : (
        <div className="space-y-6">
          {graph.sections.map((section) => (
            <section key={section.id} className="space-y-3">
              <div className="border-b pb-2">
                <h3 className="font-medium">
                  <span className="text-muted-foreground mr-2 tabular-nums">
                    {section.ordinal + 1}.
                  </span>
                  {section.title}
                </h3>
                {section.description && (
                  <p className="text-muted-foreground mt-1 text-sm">{section.description}</p>
                )}
              </div>

              {section.questions.length === 0 ? (
                <p className="text-muted-foreground text-sm italic">
                  No questions in this section.
                </p>
              ) : (
                <ul className="space-y-3">
                  {section.questions.map((q) => {
                    const issue = questionConfigIssue(q.type, q.typeConfig);
                    return (
                      <li
                        key={q.id}
                        className={`rounded-md border p-3 ${issue ? QUESTION_ISSUE_RING : ''}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm font-medium">{q.prompt}</p>
                          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                            <QuestionConfigWarning issue={issue} />
                            <Badge variant="secondary" className="text-xs">
                              {QUESTION_TYPE_LABELS[q.type] ?? q.type}
                            </Badge>
                            {q.required && (
                              <Badge variant="outline" className="text-xs">
                                required
                              </Badge>
                            )}
                          </div>
                        </div>
                        {q.guidelines && (
                          <p className="text-muted-foreground mt-1 text-sm">{q.guidelines}</p>
                        )}
                        <p className="text-muted-foreground mt-2 font-mono text-xs">
                          key: {q.key}
                          {q.extractionConfidence !== null && (
                            <span className="ml-3">
                              confidence: {Math.round(q.extractionConfidence * 100)}%
                            </span>
                          )}
                        </p>
                        {q.tags.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {q.tags.map((t) => (
                              <TagChip key={t.id} tag={t} />
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
