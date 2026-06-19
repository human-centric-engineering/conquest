/**
 * Respondent report tab — configuration for the **Respondent Report** (report kind
 * `respondent`): the per-respondent summary delivered to a respondent after they complete the
 * questionnaire. This is the first of two report kinds; the later cross-respondent **Cohort
 * Report** (`cohort`) will get its own tab + config.
 *
 * Lives under the version segment for the shared workspace chrome (header + tabs). Gated behind
 * APP_QUESTIONNAIRES_RESPONDENT_REPORT_ENABLED on top of the master flag — `notFound()`s when
 * either is off, mirroring the tab's visibility in `workspace-nav.ts`.
 *
 * The body is a tabbed configuration shell; the individual config panels are stubs for now and
 * get filled in as the feature is built out.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { resolveQuestionnaireWorkspaceFlags } from '@/lib/app/questionnaire/workspace-data';

export const metadata: Metadata = {
  title: 'Respondent report · Questionnaire',
  description: 'Configure the per-respondent report delivered after a respondent completes.',
};

interface PageProps {
  params: Promise<{ id: string; vid: string }>;
}

/** Configuration sections of the respondent report. Stubs for now — panels land as built. */
const REPORT_CONFIG_TABS = [
  {
    value: 'content',
    label: 'Content',
    blurb: 'Which sections, answers, and summaries the report includes.',
  },
  {
    value: 'generation',
    label: 'Generation',
    blurb: 'How the report is produced — template vs AI narrative, prompt, model, and tone.',
  },
  {
    value: 'delivery',
    label: 'Delivery',
    blurb: 'When and how the report reaches the respondent — on-screen, email, or download.',
  },
  {
    value: 'appearance',
    label: 'Appearance',
    blurb: 'Branding and layout of the delivered report.',
  },
] as const;

export default async function RespondentReportTab({ params }: PageProps) {
  const flags = await resolveQuestionnaireWorkspaceFlags();
  if (!flags.respondentReport) notFound();

  // Reserved for the config fetch wired up as panels are built.
  await params;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground max-w-2xl text-sm">
        The <span className="text-foreground font-medium">Respondent Report</span> is the
        personalised summary a respondent receives after completing this questionnaire. Configure
        what it contains, how it&rsquo;s generated, and how it&rsquo;s delivered. (Aggregate
        cross-respondent analysis lives in the separate <em>Cohort Report</em>, built later.)
      </p>

      <Tabs defaultValue="content" className="w-full">
        <TabsList>
          {REPORT_CONFIG_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {REPORT_CONFIG_TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value} className="pt-4">
            <div className="rounded-lg border border-dashed p-6">
              <h2 className="text-sm font-medium">{tab.label}</h2>
              <p className="text-muted-foreground mt-1 text-sm">{tab.blurb}</p>
              <p className="text-muted-foreground mt-3 text-xs">Configuration coming soon.</p>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
