'use client';

/**
 * RespondentReportEditor — the Respondent Report configuration UI (its own workspace tab).
 *
 * A self-contained controlled-state editor (not threaded through the version-editor's `run`, since
 * this is a standalone tab): the four panels (Content / Generation / Delivery / Appearance) edit one
 * `RespondentReportSettings` block, and a single Save sends it through the shared config PATCH
 * (`respondentReport` slice). `<FieldHelp>` on every non-obvious control. The Generation panel applies
 * to the AI modes (`raw_plus_insights`, `narrative`) — hinted (not hidden) in raw mode so the admin
 * sees what enabling an AI report unlocks; narrative also hides the raw-content toggles (it has no
 * separate raw section).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { ReportConfigAssistant } from '@/components/admin/questionnaires/report/report-config-assistant';
import {
  isAiRespondentReportMode,
  MAX_REPORT_RESEARCH_RESULTS,
  MAX_REPORT_RESEARCH_ROUNDS,
  REPORT_RESEARCH_DISPLAYS,
  REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH,
  REPORT_RESEARCH_TIMINGS,
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  RESPONDENT_REPORT_NARRATIVE_STYLES,
  type ReportResearchDisplay,
  type ReportResearchTiming,
  type RespondentReportMode,
  type RespondentReportNarrativeStyle,
  type RespondentReportSettings,
} from '@/lib/app/questionnaire/types';

const MODE_LABELS: Record<RespondentReportMode, string> = {
  raw: 'Raw answers only',
  raw_plus_insights: 'Raw answers + AI insights',
  narrative: 'Narrative report',
};

const NARRATIVE_STYLE_LABELS: Record<RespondentReportNarrativeStyle, string> = {
  flowing: 'Flowing prose',
  concise: 'Concise',
  structured: 'Structured (headings + bullets)',
};

const RESEARCH_TIMING_LABELS: Record<ReportResearchTiming, string> = {
  before: 'Before the report is written',
  after: 'After the report is written',
  both: 'Both before and after',
};

const RESEARCH_DISPLAY_LABELS: Record<ReportResearchDisplay, string> = {
  table: 'Table',
  list: 'List',
  hidden: 'Hidden (informs the report only)',
};

/** Parse a number input to a bounded integer, falling back to `fallback` on empty/NaN. */
function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface RespondentReportEditorProps {
  questionnaireId: string;
  versionId: string;
  initial: RespondentReportSettings;
  /** Whether the data-slots feature is on (gates the data-slot include toggle). */
  dataSlotsEnabled: boolean;
  /** The questionnaire's attributed demo client (whose KB grounds reports), or null when generic. */
  client: { id: string; name: string } | null;
  /** Whether the report web-search platform flag is on (gates the Research tab). */
  webSearchEnabled: boolean;
}

export function RespondentReportEditor({
  questionnaireId,
  versionId,
  initial,
  dataSlotsEnabled,
  client,
  webSearchEnabled,
}: RespondentReportEditorProps) {
  const router = useRouter();
  const [value, setValue] = useState<RespondentReportSettings>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  // Both AI modes (raw_plus_insights, narrative) consult the generation config + agent.
  const usesAgent = isAiRespondentReportMode(value.mode);
  // Narrative weaves answers into the report — there's no separate raw section to configure.
  const narrative = value.mode === 'narrative';

  function patch(next: Partial<RespondentReportSettings>) {
    setValue((v) => ({ ...v, ...next }));
    setSavedOk(false);
  }
  function patchGeneration(next: Partial<RespondentReportSettings['generation']>) {
    setValue((v) => ({ ...v, generation: { ...v.generation, ...next } }));
    setSavedOk(false);
  }
  function patchResearch(next: Partial<RespondentReportSettings['research']>) {
    setValue((v) => ({ ...v, research: { ...v.research, ...next } }));
    setSavedOk(false);
  }
  const research = value.research;
  const showsAfter = research.timing === 'after' || research.timing === 'both';
  const showsBefore = research.timing === 'before' || research.timing === 'both';

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
          {webSearchEnabled && <TabsTrigger value="research">Research</TabsTrigger>}
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
                section below the answers. <strong>Narrative report</strong> weaves the answers into
                one flowing, analysed report (no separate raw section). Both AI modes are generated
                after submission.
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

          {/* Raw content is the separate answer section — narrative weaves answers in, so it has no
              such section and these toggles don't apply. */}
          {narrative ? (
            <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
              A narrative report weaves the respondent&rsquo;s answers into one woven report — there
              is no separate raw answer section to configure. Shape it on the{' '}
              <span className="text-foreground font-medium">Generation</span> tab.
            </p>
          ) : (
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
          )}
        </TabsContent>

        {/* ── Generation ────────────────────────────────────────────────────── */}
        <TabsContent value="generation" className="space-y-5 pt-4">
          {!usesAgent && (
            <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
              These settings shape the AI report. Switch the mode to{' '}
              <span className="text-foreground font-medium">Raw answers + AI insights</span> or{' '}
              <span className="text-foreground font-medium">Narrative report</span> (Content tab) to
              use them.
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
            disabled={isSaving || !usesAgent}
          />

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              Narrative style
              <FieldHelp title="Narrative style">
                Shapes how the AI report reads. <strong>Flowing prose</strong> is connected,
                analysed paragraphs. <strong>Concise</strong> is tighter and shorter.{' '}
                <strong>Structured</strong> is highly scannable — a brief framing per section, then
                short paragraphs and bullet lists. All styles write in short, readable paragraphs
                and stay grounded in the respondent&rsquo;s own answers. This is separate from the
                free-text voice instructions below.
              </FieldHelp>
            </Label>
            <Select
              value={value.generation.narrativeStyle}
              onValueChange={(v) =>
                patchGeneration({ narrativeStyle: v as RespondentReportNarrativeStyle })
              }
              disabled={isSaving || !usesAgent}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RESPONDENT_REPORT_NARRATIVE_STYLES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {NARRATIVE_STYLE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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
              disabled={isSaving || !usesAgent}
              placeholder="e.g. Warm and encouraging; plain language; address the respondent as 'you'."
              onChange={(e) => patchGeneration({ instructions: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rr-structure" className="flex items-center gap-1">
              Desired structure
              <FieldHelp title="Structure">
                Describe the sections you want, in order — e.g. &ldquo;summary, three themes, then
                next steps&rdquo;. In narrative mode these become the woven report&rsquo;s chapters.
              </FieldHelp>
            </Label>
            <Textarea
              id="rr-structure"
              value={value.generation.structure}
              maxLength={RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH}
              rows={3}
              disabled={isSaving || !usesAgent}
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
              disabled={isSaving || !usesAgent}
              placeholder="e.g. This is a quarterly engagement pulse. Low autonomy scores usually point to process friction; emphasise practical, low-effort actions."
              onChange={(e) => patchGeneration({ backgroundContext: e.target.value })}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Switch
                checked={value.generation.useClientKnowledge}
                onCheckedChange={(v) => patchGeneration({ useClientKnowledge: v })}
                disabled={isSaving || !usesAgent}
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
            {usesAgent &&
              value.generation.useClientKnowledge &&
              (client ? (
                <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
                  Documents are managed on the client&rsquo;s page (the corpus is shared across all{' '}
                  {client.name}&rsquo;s questionnaires).{' '}
                  <Link
                    href={`/admin/demo-clients/${client.id}`}
                    className="text-foreground font-medium underline underline-offset-2"
                  >
                    Manage {client.name}&rsquo;s knowledge base
                  </Link>
                  .
                </p>
              ) : (
                <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
                  No demo client is attributed to this questionnaire, so there is no private
                  knowledge base to ground reports in. Attribute one on the{' '}
                  <span className="text-foreground font-medium">Settings</span> tab, then manage its
                  documents from the client&rsquo;s page.
                </p>
              ))}
          </div>
        </TabsContent>

        {/* ── Research (web search) ─────────────────────────────────────────── */}
        {webSearchEnabled && (
          <TabsContent value="research" className="space-y-5 pt-4">
            <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
              Optional web-search rounds bring live external context into the report. A research
              agent runs your instructions as web searches, refining each query from the last one,
              and the findings can appear as a Research section and/or inform the report&rsquo;s
              writing. Requires the search backend to be configured on the server.
            </p>

            <div className="flex items-center gap-2">
              <Switch
                checked={research.enabled}
                onCheckedChange={(v) => patchResearch({ enabled: v })}
                disabled={isSaving || !usesAgent}
                id="rr-research-enabled"
              />
              <Label htmlFor="rr-research-enabled" className="flex items-center gap-1">
                Enable web-search rounds
                <FieldHelp title="Web-search rounds">
                  When on, report generation runs one or more web searches to gather external
                  context. Only applies to the AI report modes. Also requires the platform feature
                  flag and a configured search backend; if the backend is unavailable, the report is
                  still generated without research.
                </FieldHelp>
              </Label>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                When to search
                <FieldHelp title="When to search">
                  <strong>Before</strong> gathers context first and can inform how the report is
                  written. <strong>After</strong> researches the finished report to enrich or
                  fact-check it. <strong>Both</strong> runs a set of rounds on each side.
                </FieldHelp>
              </Label>
              <Select
                value={research.timing}
                onValueChange={(v) => patchResearch({ timing: v as ReportResearchTiming })}
                disabled={isSaving || !usesAgent || !research.enabled}
              >
                <SelectTrigger className="max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_RESEARCH_TIMINGS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {RESEARCH_TIMING_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap gap-6">
              <div className="space-y-1.5">
                <Label htmlFor="rr-research-rounds" className="flex items-center gap-1">
                  Rounds per phase
                  <FieldHelp title="Rounds">
                    The maximum number of searches the agent may run in each phase. Each round
                    builds on the previous results. More rounds means deeper research but higher
                    cost and latency (1&ndash;{MAX_REPORT_RESEARCH_ROUNDS}).
                  </FieldHelp>
                </Label>
                <Input
                  id="rr-research-rounds"
                  type="number"
                  min={1}
                  max={MAX_REPORT_RESEARCH_ROUNDS}
                  className="w-28"
                  value={research.rounds}
                  disabled={isSaving || !usesAgent || !research.enabled}
                  onChange={(e) =>
                    patchResearch({
                      rounds: clampInt(
                        e.target.value,
                        1,
                        MAX_REPORT_RESEARCH_ROUNDS,
                        research.rounds
                      ),
                    })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rr-research-results" className="flex items-center gap-1">
                  Results per round
                  <FieldHelp title="Results per round">
                    How many search results to request each round (1&ndash;
                    {MAX_REPORT_RESEARCH_RESULTS}).
                  </FieldHelp>
                </Label>
                <Input
                  id="rr-research-results"
                  type="number"
                  min={1}
                  max={MAX_REPORT_RESEARCH_RESULTS}
                  className="w-28"
                  value={research.maxResults}
                  disabled={isSaving || !usesAgent || !research.enabled}
                  onChange={(e) =>
                    patchResearch({
                      maxResults: clampInt(
                        e.target.value,
                        1,
                        MAX_REPORT_RESEARCH_RESULTS,
                        research.maxResults
                      ),
                    })
                  }
                />
              </div>
            </div>

            {showsBefore && (
              <div className="space-y-1.5">
                <Label htmlFor="rr-research-before" className="flex items-center gap-1">
                  Before-search instructions
                  <FieldHelp title="Before-search instructions">
                    Tell the research agent what to look for before the report is written and what
                    to do with it — e.g. &ldquo;Find recent industry benchmarks for the topics
                    covered and summarise how this respondent compares.&rdquo;
                  </FieldHelp>
                </Label>
                <Textarea
                  id="rr-research-before"
                  value={research.before.instructions}
                  maxLength={REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH}
                  rows={3}
                  disabled={isSaving || !usesAgent || !research.enabled}
                  placeholder="e.g. Research current best-practice guidance on the themes raised, and note what should inform the report."
                  onChange={(e) => patchResearch({ before: { instructions: e.target.value } })}
                />
              </div>
            )}

            {showsAfter && (
              <div className="space-y-1.5">
                <Label htmlFor="rr-research-after" className="flex items-center gap-1">
                  After-search instructions
                  <FieldHelp title="After-search instructions">
                    Tell the agent what to verify or enrich once the report is drafted — e.g.
                    &ldquo;Find authoritative sources and links that support the
                    recommendations.&rdquo;
                  </FieldHelp>
                </Label>
                <Textarea
                  id="rr-research-after"
                  value={research.after.instructions}
                  maxLength={REPORT_RESEARCH_INSTRUCTIONS_MAX_LENGTH}
                  rows={3}
                  disabled={isSaving || !usesAgent || !research.enabled}
                  placeholder="e.g. Find supporting sources and helpful links for the recommended next steps."
                  onChange={(e) => patchResearch({ after: { instructions: e.target.value } })}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                Show findings as
                <FieldHelp title="Show findings">
                  How the retrieved sources appear in the report. <strong>Table</strong> and{' '}
                  <strong>List</strong> both show clickable links with details.{' '}
                  <strong>Hidden</strong> keeps the findings out of the report but still lets them
                  inform the writing (turn on &ldquo;inform the report&rdquo; below).
                </FieldHelp>
              </Label>
              <Select
                value={research.display}
                onValueChange={(v) => patchResearch({ display: v as ReportResearchDisplay })}
                disabled={isSaving || !usesAgent || !research.enabled}
              >
                <SelectTrigger className="max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_RESEARCH_DISPLAYS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {RESEARCH_DISPLAY_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={research.informNarrative}
                onCheckedChange={(v) => patchResearch({ informNarrative: v })}
                disabled={isSaving || !usesAgent || !research.enabled || !showsBefore}
                id="rr-research-inform"
              />
              <Label htmlFor="rr-research-inform" className="flex items-center gap-1">
                Let before-search findings inform the report
                <FieldHelp title="Inform the report">
                  When on, the &ldquo;before&rdquo; findings are given to the report writer as
                  general background (framed as context about the topic, never attributed to the
                  respondent). When off, findings only appear in the Research section and never
                  influence the report&rsquo;s prose. Applies to before-search only.
                </FieldHelp>
              </Label>
            </div>
          </TabsContent>
        )}

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
