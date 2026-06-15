import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { ComposeStudio } from '@/components/admin/questionnaires/compose/compose-studio';
import { FieldHelp } from '@/components/ui/field-help';
import {
  isGenerativeAuthoringEnabled,
  isQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';

export const metadata: Metadata = {
  title: 'Compose a questionnaire',
  description: 'Describe your goal and watch the questionnaire build.',
};

/**
 * Admin — Compose Studio (generative authoring).
 *
 * Thin server shell: gates on BOTH the master questionnaire flag and the
 * generative-authoring sub-flag (404 when either is off — the surface is dark and
 * the API would 404 too), then hands off to the client `<ComposeStudio>`, which
 * owns the brief → stream → refine flow.
 */
export default async function ComposeQuestionnairePage() {
  if (!(await isQuestionnairesEnabled()) || !(await isGenerativeAuthoringEnabled())) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/questionnaires"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="h-4 w-4" />
          Questionnaires
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          Compose a questionnaire{' '}
          <FieldHelp title="Generative authoring" contentClassName="w-96">
            <p>
              Describe what you want to learn and from whom. An agent plans the sections, then
              writes the questions for each — streaming them in as it goes.
            </p>
            <p className="text-foreground mt-2 font-medium">After it builds</p>
            <p>
              Refine it conversationally (&ldquo;make it shorter&rdquo;, &ldquo;add a section on
              pricing&rdquo;), then open it in the Structure editor as a draft.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Describe your goal and watch the questionnaire build — then refine it before editing.
        </p>
      </div>

      <ComposeStudio />
    </div>
  );
}
