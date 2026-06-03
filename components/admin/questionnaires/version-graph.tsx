/**
 * VersionGraph (P2 / F2.1a) — read-only render of one version's structural graph.
 *
 * Pure presentational server component: goal + audience (with read-time
 * "inferred" badges) followed by the section → question tree. No interactivity —
 * editing arrives in F2.1b (PR2). Consumes the `VersionGraphView` contract the
 * `GET …/versions/:vid` endpoint returns.
 */

import { Badge } from '@/components/ui/badge';
import { AUDIENCE_FIELDS, QUESTION_TYPE_LABELS } from '@/lib/app/questionnaire/types';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';

import { TagChip } from '@/components/admin/questionnaires/tag-chip';

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
    <Badge variant="outline" className="ml-2 align-middle text-xs font-normal">
      inferred
    </Badge>
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
      <section className="space-y-4 rounded-md border p-4">
        <div>
          <h3 className="text-sm font-medium">
            Goal
            {graph.goalProvenance === 'inferred' && <InferredBadge />}
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            {graph.goal ?? <span className="italic">Not set</span>}
          </p>
        </div>
        <div>
          <h3 className="text-sm font-medium">Audience</h3>
          {audienceEntries.length > 0 ? (
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              {audienceEntries.map((e) => (
                <div key={e.label} className="contents">
                  <dt className="text-muted-foreground">{e.label}</dt>
                  <dd>
                    {e.value}
                    {e.inferred && <InferredBadge />}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-muted-foreground mt-1 text-sm italic">Not set</p>
          )}
        </div>
        {graph.tags.length > 0 && (
          <div>
            <h3 className="text-sm font-medium">Tags</h3>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {graph.tags.map((t) => (
                <TagChip key={t.id} tag={t} />
              ))}
            </div>
          </div>
        )}
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
                  {section.questions.map((q) => (
                    <li key={q.id} className="rounded-md border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-medium">{q.prompt}</p>
                        <div className="flex shrink-0 items-center gap-1">
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
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
