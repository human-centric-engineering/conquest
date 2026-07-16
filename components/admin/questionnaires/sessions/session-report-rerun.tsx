'use client';

/**
 * SessionReportRerun — the admin "re-run this session's report" surface, opened from the session
 * viewer's action bar.
 *
 * An admin edits the report instructions/settings (starting from the questionnaire's current report
 * config) and re-runs the report against THIS real session's captured answers. Each re-run is a retained
 * revision generated asynchronously by the maintenance worker; the panel polls its status and lets the
 * admin view any completed re-run and PROMOTE it into the delivered report the respondent sees.
 *
 * Self-contained controlled state — reads/writes the re-run API directly (`apiClient`). Parent renders
 * this only when the respondent-report feature is on.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { ReportBody, ReportPaperHeader } from '@/components/app/questionnaire/report/report-body';
import type { RespondentReportContent } from '@/lib/app/questionnaire/report/content';
import type {
  DeliveredReportSummary,
  RespondentReportRevisionSummary,
  RespondentReportRevisionsView,
} from '@/lib/app/questionnaire/report/revision';
import {
  RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH,
  RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH,
  RESPONDENT_REPORT_NARRATIVE_STYLES,
  RESPONDENT_REPORT_RERUN_NOTE_MAX_LENGTH,
  type RespondentReportMode,
  type RespondentReportNarrativeStyle,
  type RespondentReportSettings,
  type RespondentReportStatus,
} from '@/lib/app/questionnaire/types';

/** Re-run supports only the AI modes (raw has nothing to generate). */
const MODE_ORDER: Exclude<RespondentReportMode, 'raw'>[] = ['narrative', 'raw_plus_insights'];
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

const STATUS_BADGE: Record<
  RespondentReportStatus,
  { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }
> = {
  queued: { label: 'Queued', variant: 'secondary' },
  processing: { label: 'Generating…', variant: 'secondary' },
  ready: { label: 'Ready', variant: 'default' },
  failed: { label: 'Failed', variant: 'destructive' },
};

/** One revision's fetched content, for the in-panel viewer. */
interface RevisionDetail {
  revisionNumber: number;
  status: RespondentReportStatus;
  mode: RespondentReportMode;
  instructions: string | null;
  content: RespondentReportContent | null;
  formatted: boolean;
  completionPct: number | null;
  error: string | null;
}

export interface SessionReportRerunProps {
  sessionId: string;
  /** The questionnaire's current report config — the re-run starting point. */
  initialSettings: RespondentReportSettings;
  /** The delivered report + existing re-run history at page load. */
  initialView: RespondentReportRevisionsView;
  /** Whether the questionnaire has an attributed client KB (gates the KB-grounding toggle). */
  hasClient: boolean;
  className?: string;
}

export function SessionReportRerun({
  sessionId,
  initialSettings,
  initialView,
  hasClient,
  className,
}: SessionReportRerunProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<RespondentReportRevisionsView>(initialView);
  const [settings, setSettings] = useState<RespondentReportSettings>(() =>
    normaliseStart(initialSettings)
  );
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<RevisionDetail | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [promoting, setPromoting] = useState<number | null>(null);

  const gen = settings.generation;
  const patchGen = (next: Partial<RespondentReportSettings['generation']>) =>
    setSettings((s) => ({ ...s, generation: { ...s.generation, ...next } }));

  const inFlight = view.revisions.some((r) => r.status === 'queued' || r.status === 'processing');

  const refresh = useCallback(async () => {
    try {
      const next = await apiClient.get<RespondentReportRevisionsView>(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevisions(sessionId)
      );
      setView(next);
    } catch {
      // Poll failures are transient — keep the last good view.
    }
  }, [sessionId]);

  // Poll while a re-run is queued/processing, but only while the dialog is open. `refresh` is stable
  // (memoised on sessionId), so listing it as a dep never re-arms the interval spuriously.
  useEffect(() => {
    if (!open || !inFlight) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [open, inFlight, refresh]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post(API.APP.QUESTIONNAIRE_SESSIONS.reportRevisions(sessionId), {
        body: { config: settings, instructions: note.trim() || undefined },
      });
      setNote('');
      await refresh();
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not start the re-run. Please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const openRevision = async (revisionNumber: number) => {
    setViewLoading(true);
    setViewing(null);
    try {
      const detail = await apiClient.get<RevisionDetail>(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevision(sessionId, revisionNumber)
      );
      setViewing(detail);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not load that revision.');
    } finally {
      setViewLoading(false);
    }
  };

  const promote = async (revisionNumber: number) => {
    setPromoting(revisionNumber);
    setError(null);
    try {
      await apiClient.post(
        API.APP.QUESTIONNAIRE_SESSIONS.reportRevisionPromote(sessionId, revisionNumber)
      );
      await refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not promote that revision.');
    } finally {
      setPromoting(null);
    }
  };

  const revisionCount = view.revisions.length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={className}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Re-run report
          {revisionCount > 0 && (
            <Badge variant="secondary" className="ml-1.5">
              {revisionCount}
            </Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[calc(100dvh-3rem)] w-[calc(100vw-2rem)] max-w-[860px] flex-col gap-0 overflow-hidden p-0 sm:rounded-xl">
        <DialogHeader className="bg-background flex-row items-center justify-between space-y-0 border-b px-5 py-3 text-left">
          <div>
            <DialogTitle className="text-sm font-semibold">Respondent report re-runs</DialogTitle>
            <DialogDescription className="text-xs">
              Re-run this session&rsquo;s report with new instructions, then promote a result to
              replace what the respondent sees.
            </DialogDescription>
          </div>
          {viewing && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setViewing(null)}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Back
            </Button>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {viewing ? (
            <RevisionContentView detail={viewing} />
          ) : (
            <div className="space-y-6 p-5">
              {/* ── New re-run form ─────────────────────────────────────────── */}
              <section className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1 text-sm">
                      Report mode
                      <FieldHelp title="Report mode">
                        Both AI modes are supported. <strong>Narrative</strong> weaves the answers
                        into one flowing report; <strong>Raw + insights</strong> adds an AI insights
                        section.
                      </FieldHelp>
                    </Label>
                    <Select
                      value={settings.mode === 'raw' ? 'narrative' : settings.mode}
                      onValueChange={(v) =>
                        setSettings((s) => ({ ...s, mode: v as RespondentReportMode }))
                      }
                      disabled={submitting}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MODE_ORDER.map((m) => (
                          <SelectItem key={m} value={m}>
                            {MODE_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1 text-sm">Narrative style</Label>
                    <Select
                      value={gen.narrativeStyle}
                      onValueChange={(v) =>
                        patchGen({ narrativeStyle: v as RespondentReportNarrativeStyle })
                      }
                      disabled={submitting}
                    >
                      <SelectTrigger>
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
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="rerun-instructions" className="flex items-center gap-1 text-sm">
                    Style &amp; voice instructions
                    <FieldHelp title="Instructions">
                      Free-text guidance for how the report should sound — layered on top of the
                      report agent&rsquo;s default voice.
                    </FieldHelp>
                  </Label>
                  <Textarea
                    id="rerun-instructions"
                    rows={2}
                    value={gen.instructions}
                    maxLength={RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH}
                    disabled={submitting}
                    placeholder="e.g. Warm and encouraging; plain language; address the respondent as 'you'."
                    onChange={(e) => patchGen({ instructions: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="rerun-structure" className="flex items-center gap-1 text-sm">
                    Desired structure
                  </Label>
                  <Textarea
                    id="rerun-structure"
                    rows={2}
                    value={gen.structure}
                    maxLength={RESPONDENT_REPORT_INSTRUCTIONS_MAX_LENGTH}
                    disabled={submitting}
                    placeholder="e.g. A short summary, then strengths, then areas to develop, then recommended actions."
                    onChange={(e) => patchGen({ structure: e.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="rerun-background" className="flex items-center gap-1 text-sm">
                    Background context
                  </Label>
                  <Textarea
                    id="rerun-background"
                    rows={3}
                    value={gen.backgroundContext}
                    maxLength={RESPONDENT_REPORT_BACKGROUND_MAX_LENGTH}
                    disabled={submitting}
                    placeholder="What the agent should know about this questionnaire and how to interpret answers."
                    onChange={(e) => patchGen({ backgroundContext: e.target.value })}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="rerun-confidence"
                      checked={gen.discountLowConfidence}
                      onCheckedChange={(v) => patchGen({ discountLowConfidence: v })}
                      disabled={submitting}
                    />
                    <Label htmlFor="rerun-confidence" className="text-sm font-normal">
                      Discount low-confidence answers
                    </Label>
                  </div>
                  {hasClient && (
                    <div className="flex items-center gap-2">
                      <Switch
                        id="rerun-kb"
                        checked={gen.useClientKnowledge}
                        onCheckedChange={(v) => patchGen({ useClientKnowledge: v })}
                        disabled={submitting}
                      />
                      <Label htmlFor="rerun-kb" className="text-sm font-normal">
                        Ground in the client knowledge base
                      </Label>
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="rerun-note" className="flex items-center gap-1 text-sm">
                    Note (optional)
                    <FieldHelp title="Re-run note">
                      A short reminder of why you re-ran or what you changed — shown in the history
                      below.
                    </FieldHelp>
                  </Label>
                  <Input
                    id="rerun-note"
                    value={note}
                    maxLength={RESPONDENT_REPORT_RERUN_NOTE_MAX_LENGTH}
                    disabled={submitting}
                    placeholder="e.g. Warmer tone, added benchmarking context."
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>

                <div className="flex items-center gap-3">
                  <Button type="button" onClick={() => void submit()} disabled={submitting}>
                    {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    Re-run report
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    Generated in the background — this can take a minute.
                  </span>
                </div>
                {error && <p className="text-destructive text-sm">{error}</p>}
              </section>

              {/* ── History ─────────────────────────────────────────────────── */}
              <section className="space-y-3 border-t pt-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Re-run history</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void refresh()}
                    className="text-muted-foreground h-7 px-2 text-xs"
                  >
                    <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
                    Refresh
                  </Button>
                </div>
                <DeliveredLine delivered={view.delivered} />
                {revisionCount === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No re-runs yet. Adjust the settings above and re-run to create one.
                  </p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {view.revisions.map((r) => (
                      <RevisionRow
                        key={r.id}
                        revision={r}
                        viewLoading={viewLoading}
                        promoting={promoting === r.revisionNumber}
                        onView={() => void openRevision(r.revisionNumber)}
                        onPromote={() => void promote(r.revisionNumber)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Force the starting mode to an AI mode (re-run can't do raw); leave the rest of the config intact. */
function normaliseStart(settings: RespondentReportSettings): RespondentReportSettings {
  return settings.mode === 'raw' ? { ...settings, mode: 'narrative' } : settings;
}

function DeliveredLine({ delivered }: { delivered: DeliveredReportSummary | null }) {
  if (!delivered) {
    return (
      <p className="text-muted-foreground text-xs">This session has no delivered report yet.</p>
    );
  }
  const badge = STATUS_BADGE[delivered.status];
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
      <span>Delivered report:</span>
      <Badge variant={badge.variant}>{badge.label}</Badge>
      {delivered.deliveredRevisionId ? (
        <span>currently showing a promoted re-run.</span>
      ) : (
        <span>currently showing the original generation.</span>
      )}
    </div>
  );
}

function RevisionRow({
  revision,
  viewLoading,
  promoting,
  onView,
  onPromote,
}: {
  revision: RespondentReportRevisionSummary;
  viewLoading: boolean;
  promoting: boolean;
  onView: () => void;
  onPromote: () => void;
}) {
  const badge = STATUS_BADGE[revision.status];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
      <span className="font-mono text-xs font-semibold">#{revision.revisionNumber}</span>
      <Badge variant={badge.variant}>{badge.label}</Badge>
      {revision.delivered && <Badge variant="outline">Delivered</Badge>}
      <span className="text-muted-foreground text-xs">{MODE_LABELS[revision.mode]}</span>
      {revision.instructions && (
        <span className="text-muted-foreground max-w-[24rem] truncate text-xs italic">
          “{revision.instructions}”
        </span>
      )}
      {revision.status === 'failed' && revision.error && (
        <span className="text-destructive max-w-[24rem] truncate text-xs">{revision.error}</span>
      )}
      <span className="text-muted-foreground ml-auto text-xs">
        {new Date(revision.createdAt).toLocaleString()}
      </span>
      {revision.status === 'ready' && (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onView}
            disabled={viewLoading}
          >
            View
          </Button>
          {!revision.delivered && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onPromote}
              disabled={promoting}
            >
              {promoting && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Promote
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function RevisionContentView({ detail }: { detail: RevisionDetail }) {
  if (detail.status === 'failed') {
    return (
      <div className="p-6">
        <p className="text-destructive text-sm">
          This re-run failed{detail.error ? `: ${detail.error}` : '.'}
        </p>
      </div>
    );
  }
  if (!detail.content) {
    return <div className="text-muted-foreground p-6 text-sm">This re-run has no content yet.</div>;
  }
  return (
    <div className="bg-muted/40 p-4 sm:p-8">
      <div className="mx-auto w-full max-w-[210mm]">
        <div className="rounded-sm bg-white px-[9%] py-[8%] text-neutral-900 shadow-xl ring-1 ring-black/5 sm:px-[12%] sm:py-[10%]">
          <ReportPaperHeader title={`Re-run #${detail.revisionNumber}`} header={null} />
          <ReportBody
            content={detail.content}
            formatted={detail.formatted}
            completionPct={detail.completionPct}
            variant="paper"
            animate={false}
          />
        </div>
      </div>
    </div>
  );
}
