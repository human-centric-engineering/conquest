/**
 * Worked examples of an experience kind.
 *
 * A server component — the examples are static data and none of this is interactive, so there is no
 * reason to ship it to the client. Rendered on the How-it-works tab and beneath the kind selector
 * on the create form.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { examplesForKind } from '@/lib/app/questionnaire/experiences/examples';
import type { ExperienceKind } from '@/lib/app/questionnaire/experiences/types';

interface ExperienceExamplesProps {
  kind: ExperienceKind;
  /** Trim to the first N — the create form wants a taste, the How-it-works tab wants all of them. */
  limit?: number;
}

/**
 * Title-and-scenario only, for tight spaces.
 *
 * The create form lives in a dialog, where three full cards would bury the fields the author came
 * to fill in. This variant answers "what is this kind FOR?" in a few lines and leaves the detail to
 * the How-it-works tab.
 */
export function ExperienceExamplesCompact({ kind }: { kind: ExperienceKind }) {
  const examples = examplesForKind(kind);
  if (examples.length === 0) return null;

  return (
    <div className="bg-muted/40 rounded-md border p-3">
      <p className="text-xs font-medium tracking-wide uppercase">For example</p>
      <ul className="mt-2 space-y-1.5">
        {examples.map((example) => (
          <li key={example.id} className="text-sm">
            <span className="font-medium">{example.title}</span>
            <span className="text-muted-foreground"> — {example.scenario}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ExperienceExamples({ kind, limit }: ExperienceExamplesProps) {
  const all = examplesForKind(kind);
  const examples = typeof limit === 'number' ? all.slice(0, limit) : all;

  if (examples.length === 0) return null;

  return (
    <div className="space-y-4">
      {examples.map((example) => (
        <Card key={example.id}>
          <CardHeader>
            <CardTitle className="text-base">{example.title}</CardTitle>
            <p className="text-muted-foreground text-sm">{example.scenario}</p>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ol className="space-y-2">
              {example.steps.map((step, index) => (
                <li key={`${example.id}-${index}`} className="flex gap-3">
                  <span className="bg-muted text-muted-foreground mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 text-xs font-medium">
                    {step.kind}
                  </span>
                  <span>
                    <span className="font-medium">{step.title}</span>{' '}
                    <span className="text-muted-foreground">{step.detail}</span>
                  </span>
                </li>
              ))}
            </ol>

            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium tracking-wide uppercase">Routing</dt>
                <dd className="text-muted-foreground mt-1">{example.routing}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium tracking-wide uppercase">Respondent sees</dt>
                <dd className="text-muted-foreground mt-1">{example.respondentSees}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium tracking-wide uppercase">You get</dt>
                <dd className="text-muted-foreground mt-1">{example.adminGets}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
