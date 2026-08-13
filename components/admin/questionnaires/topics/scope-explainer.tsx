'use client';

/**
 * "How adaptive scope works" — the orientation panel at the top of the tab.
 *
 * Everything else on this page is a form. Forms answer *what does this field do*; nothing on the
 * page answered *what am I building, and in what order* — and adaptive scope has an order that is
 * not guessable from the controls (group first, mark conditional second, pin certainties third,
 * switch on last). An admin who turns the switch on before any topic is conditional gets a
 * questionnaire that behaves exactly as it did before, with no clue why.
 *
 * Open by default and dismissible, remembered per browser rather than per questionnaire: the thing
 * being learned is the mechanism, which is the same on every questionnaire, so re-teaching it on
 * the next one is noise. The steps stay reachable from the header link once collapsed.
 *
 * Deliberately example-free in the domain sense. Every illustration here is drawn from a different
 * kind of instrument (a screener, a compliance audit, a role-specific survey) so no single client's
 * shape reads as the intended one.
 */

import { ChevronDown, Route } from 'lucide-react';

import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { cn } from '@/lib/utils';

/** The four authoring steps, in the order they must actually happen. */
const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Group every question into a topic',
    body: 'A topic is the unit this page decides about. Uploading a document does this for you — one topic per section, all set to “Always ask”, so nothing changes yet. A question in no topic can never be asked once you switch on.',
  },
  {
    title: 'Mark the ones that are conditional',
    body: 'Change a topic to “Ask when it fits” and write, in your own words, when it applies. Size does not matter: a thirty-question section and a single question are both just topics.',
  },
  {
    title: 'Pin anything you are certain about',
    body: 'Hard rules read the answers your opening captured and decide before the agent does — “when they are not a licence holder, never include the audit questions”. Use them for certainties; leave the judgement calls to the criteria.',
  },
  {
    title: 'Switch it on',
    body: 'When the opening finishes, the plan is decided once: your rules, then the agent judging your criteria, then your limits. The respondent is told what was chosen, and every report says which topics were never covered.',
  },
];

export interface ScopeExplainerProps {
  className?: string;
}

export function ScopeExplainer({ className }: ScopeExplainerProps) {
  const [open, setOpen] = useLocalStorage('cq.admin.scope.explainer.open.v1', true);

  return (
    <section
      className={cn('bg-card overflow-hidden rounded-lg border shadow-sm', className)}
      aria-labelledby="scope-explainer-heading"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="scope-explainer-body"
        className="hover:bg-muted/40 focus-visible:ring-ring flex w-full items-start gap-3 p-4 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
          <Route className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span id="scope-explainer-heading" className="block text-sm font-semibold tracking-tight">
            How adaptive scope works
          </span>
          <span className="text-muted-foreground block text-xs leading-relaxed">
            Ask each respondent only the parts of this questionnaire that apply to them — without
            splitting it into several questionnaires and losing the scoring and cohort analysis that
            come from one instrument.
          </span>
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground mt-1 h-4 w-4 shrink-0 transition-transform duration-200',
            open && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div id="scope-explainer-body" className="space-y-4 border-t p-4">
          <ol className="grid gap-3 sm:grid-cols-2">
            {STEPS.map((step, i) => (
              <li key={step.title} className="bg-muted/25 flex gap-3 rounded-md border p-3">
                <span
                  aria-hidden="true"
                  className="bg-background text-muted-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm leading-snug font-medium">{step.title}</p>
                  <p className="text-muted-foreground text-xs leading-relaxed">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs font-medium">What people use it for</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Screeners and eligibility checks · sections that only apply to one role, region or
                account tier · compliance areas that must be recorded as not-applicable rather than
                skipped · any long instrument that should not ask all of itself to everyone.
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium">It is off until you say otherwise</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                While the switch is off, every topic is asked and nothing on this page has any
                effect — so you can set the whole thing up, check the findings, and turn it on when
                you are satisfied. Turning it off again restores the full questionnaire.
              </p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
