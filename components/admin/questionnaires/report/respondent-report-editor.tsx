'use client';

/**
 * RespondentReportEditor — the Respondent Report configuration UI (its own workspace tab).
 *
 * A self-contained controlled-state editor (not threaded through the version-editor's `run`, since
 * this is a standalone tab): the four panels (Content / Generation / Delivery / Appearance) edit one
 * `RespondentReportSettings` block, and a single Save sends it through the shared config PATCH
 * (`respondentReport` slice). `<FieldHelp>` on every non-obvious control. The Generation panel is the
 * only one that matters in `raw_plus_insights` mode — it's hinted (not hidden) in raw mode so the
 * admin sees what enabling insights unlocks.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FieldHelp } from '@/components/ui/field-help';
import { ClientKnowledgePanel } from '@/components/admin/questionnaires/report/client-knowledge-panel';
import { ReportConfigAssistant } from '@/components/admin/questionnaires/report/report-config-assistant';
import {
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  type RespondentReportMode,
  type RespondentReportSettings,
} from '@/lib/app/questionnaire/types';

const MODE_LABELS: Record<RespondentReportMode, string> = {
  raw: 'Raw answers only',
  raw_plus_insights: 'Raw answers + AI insights',
  narrative: 'Narrative report',
};

export interface RespondentReportEditorProps {
  questionnaireId: string;
  versionId: string;
  initial: RespondentReportSettings;
  /** Whether the data-slots feature is on (gates the data-slot include toggle). */
  dataSlotsEnabled: boolean;
}

export function RespondentReportEditor({
  questionnaireId,
  versionId,
  initial,
  dataSlotsEnabled,
}: RespondentReportEditorProps) {
  const router = useRouter();
  const [value, setValue] = useState<RespondentReportSettings>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const insights = value.mode === 'raw_plus_insights';

  function patch(next: Partial<RespondentReportSettings>) {
    setValue((v) => ({ ...v, ...next }));
    setSavedOk(false);
  }
  function patchGeneration(next: Partial<RespondentReportSettings['generation']>) {
    setValue((v) => ({ ...v, generation: { ...v.generation, ...next } }));
    setSavedOk(false);
  }

  const save = async () => {
    setIsSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      await apiClient.patch(API.APP.QUESTIONNAIRES.versionConfig(questionnaireId, versionId), {
        body: { respondentReport: value },
      });
      setSavedOk(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not save the report config.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Tabs defaultValue="content" className="w-full">
        <TabsList>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="generation">Generation</TabsTrigger>
          <TabsTrigger value="delivery">Delivery</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
        </TabsList>

        {/* ── Content ───────────────────────────────────────────────────────── */}
        <TabsContent value="content" className="space-y-5 pt-4">
          <div className="flex items-center gap-2">
            <Switch
              checked={value.enabled}
              onCheckedChange={(v) => patch({ enabled: v })}
              disabled={isSaving}
              id="rr-enabled"
            />
            <Label htmlFor="rr-enabled" className="flex items-center gap-1">
              Enable the respondent report
              <FieldHelp title="Respondent report">
                When on, respondents receive a report after completing this questionnaire. Also
                requires the platform feature flag to be enabled.
              </FieldHelp>
            </Label>
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              Report mode
              <FieldHelp title="Report mode">
                <strong>Raw answers only</strong> shows the respondent their captured answers.
                <strong> Raw + AI insights</strong> adds a personalised, AI-generated insights
                section (generated after submission).
              </FieldHelp>
            </Label>
            <Select
              value={value.mode}
              onValueChange={(v) => patch({ mode: v as RespondentReportMode })}
              disabled={isSaving}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODE_LABELS) as RespondentReportMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1">
              Raw content
              <FieldHelp title="Raw content">
                Choose what the raw section shows the respondent.
              </FieldHelp>
            </Label>
            <div className="flex items-center gap-2">
              <Switch
                checked={value.rawIncludes.questionsAsPresented}
                onCheckedChange={(v) =>
                  patch({
                    rawIncludes: { ...value.rawIncludes, questionsAsPresented: v },
                  })
                }
                disabled={isSaving}
                id="rr-questions"
              />
              <Label htmlFor="rr-questions" className="text-sm font-normal">
                Questions &amp; answers as presented
              </Label>
            </div>
            {dataSlotsEnabled && (
              <div className="flex items-center gap-2">
                <Switch
                  checked={value.rawIncludes.dataSlots}
                  onCheckedChange={(v) =>
                    patch({ rawIncludes: { ...value.rawIncludes, dataSlots: v } })
                  }
                  disabled={isSaving}
                  id="rr-dataslots"
                />
                <Label htmlFor="rr-dataslots" className="text-sm font-normal">
                  Captured data-slot values
                </Label>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── Generation ────────────────────────────────────────────────────── */}
        <TabsContent value="generation" className="space-y-5 pt-4">
          {!insights && (
            <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
              These settings shape the AI insights section. Switch the mode to{' '}
              <span className="text-foreground font-medium">Raw answers + AI insights</span>{' '}
              (Content tab) to use them.
            </p>
          )}

          <ReportConfigAssistant
            questionnaireId={questionnaireId}
            versionId={versionId}
            current={{
              instructions: value.generation.instructions,
              structure: value.generation.structure,
              backgroundContext: value.generation.backgroundContext,
            }}
            onApply={patchGeneration}
            disabled={isSaving || !insights}
          />

          <div className="space-y-1.5">
            <Label htmlFor="rr-instructions" className="flex items-center gap-1">
              Style &amp; voice instructions
              <FieldHelp title="Instructions">
                Free-text guidance for how the report should sound — tone, reading level,
                perspective. Layered on top of the report agent&rsquo;s default voice.
              </FieldHelp>
            </Label>
            <Textarea
              id="rr-instructions"
              value={value.generation.instructions}
              maxLength={RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH}
              rows={3}
              disabled={isSaving || !insights}
              placeholder="e.g. Warm and encouraging; plain language; address the respondent as 'you'."
              onChange={(e) => patchGeneration({ instructions: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rr-structure" className="flex items-center gap-1">
              Desired structure
              <FieldHelp title="Structure">
                Describe the sections you want, in order — e.g. &ldquo;summary, three themes, then
                next steps&rdquo;.
              </FieldHelp>
            </Label>
            <Textarea
              id="rr-structure"
              value={value.generation.structure}
              maxLength={RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH}
              rows={3}
              disabled={isSaving || !insights}
              placeholder="e.g. A short summary, then strengths, then areas to develop, then recommended actions."
              onChange={(e) => patchGeneration({ structure: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rr-background" className="flex items-center gap-1">
              Background context
              <FieldHelp title="Background context">
                What the agent should know about this questionnaire and how to interpret answers —
                e.g. what a low score on a section implies, or domain background. Always supplied to
                the agent.
              </FieldHelp>
            </Label>
            <Textarea
              id="rr-background"
              value={value.generation.backgroundContext}
              maxLength={RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH}
              rows={5}
              disabled={isSaving || !insights}
              placeholder="e.g. This is a quarterly engagement pulse. Low autonomy scores usually point to process friction; emphasise practical, low-effort actions."
              onChange={(e) => patchGeneration({ backgroundContext: e.target.value })}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Switch
                checked={value.generation.useClientKnowledge}
                onCheckedChange={(v) => patchGeneration({ useClientKnowledge: v })}
                disabled={isSaving || !insights}
                id="rr-kb"
              />
              <Label htmlFor="rr-kb" className="flex items-center gap-1">
                Ground insights in the client knowledge base
                <FieldHelp title="Client knowledge base">
                  When on, the report agent retrieves relevant material from the attributed
                  client&rsquo;s private knowledge base to substantiate its insights. Each
                  client&rsquo;s documents are isolated.
                </FieldHelp>
              </Label>
            </div>
            {insights && value.generation.useClientKnowledge && (
              <ClientKnowledgePanel questionnaireId={questionnaireId} />
            )}
          </div>
        </TabsContent>

        {/* ── Delivery ──────────────────────────────────────────────────────── */}
        <TabsContent value="delivery" className="space-y-4 pt-4">
          <div className="flex items-center gap-2">
            <Switch
              checked={value.delivery.onScreen}
              onCheckedChange={(v) => patch({ delivery: { ...value.delivery, onScreen: v } })}
              disabled={isSaving}
              id="rr-onscreen"
            />
            <Label htmlFor="rr-onscreen" className="flex items-center gap-1">
              Show on the completion screen
              <FieldHelp title="On-screen delivery">
                Display the report to the respondent on the screen shown after they submit.
              </FieldHelp>
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={value.delivery.download}
              onCheckedChange={(v) => patch({ delivery: { ...value.delivery, download: v } })}
              disabled={isSaving}
              id="rr-download"
            />
            <Label htmlFor="rr-download" className="flex items-center gap-1">
              Offer a downloadable PDF
              <FieldHelp title="PDF download">
                Let the respondent download the report as a branded PDF.
              </FieldHelp>
            </Label>
          </div>
          <p className="text-muted-foreground text-xs">
            Email delivery is planned for a later release.
          </p>
        </TabsContent>

        {/* ── Appearance ────────────────────────────────────────────────────── */}
        <TabsContent value="appearance" className="space-y-3 pt-4">
          <p className="text-muted-foreground text-sm">
            The report is branded with the attributed demo client&rsquo;s theme (logo and accent
            colour), the same as the questionnaire&rsquo;s respondent surfaces and invitation
            emails. Set or change branding on the client (Settings tab). Per-report appearance
            overrides are planned for a later release.
          </p>
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-3 border-t pt-4">
        <Button type="button" onClick={() => void save()} disabled={isSaving}>
          {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Save configuration
        </Button>
        {savedOk && <span className="text-muted-foreground text-sm">Saved.</span>}
        {error && <span className="text-destructive text-sm">{error}</span>}
      </div>
    </div>
  );
}
