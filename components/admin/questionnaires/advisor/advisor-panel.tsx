'use client';

/**
 * AdvisorPanel — the Config Advisor surface on the version Settings tab.
 *
 * ADMIN-TRIGGERED ONLY. The panel renders an idle "Run advisor" state on mount and fires NOTHING on
 * render, tab visit, apply, or settings change. The advisor runs only when the admin presses **Run
 * advisor** / **Re-run**.
 *
 * A run POSTs the advisor stream endpoint and consumes the SSE frames (fetch → reader →
 * `parseSseBlock`, mirroring `compose-studio.tsx`): the narrative streams in token-by-token, then a
 * structured list of conflicts + one-click suggestions arrives. Each suggestion's `patch` is applied
 * through the existing version-config PATCH endpoint via `authoringMutate` — which forks a launched
 * version and runs full validation — with the same fork-notice + redirect discipline as
 * `version-settings-panel.tsx`. After any apply the panel marks itself stale and invites a re-run.
 * Ephemeral: nothing is persisted; leaving and returning resets to the idle state.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, Sparkles, RefreshCw, Check, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FieldHelp } from '@/components/ui/field-help';
import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { MARKDOWN_BLOCK_CLASSES } from '@/components/admin/orchestration/markdown-or-raw-view';
import {
  authoringMutate,
  AuthoringError,
} from '@/components/admin/questionnaires/authoring-mutate';
import type { VersionGraphView } from '@/lib/app/questionnaire/views';
import type { AdvisorGenEvent } from '@/lib/app/questionnaire/advisor/advisor-events';
import type {
  AdvisorConflict,
  AdvisorSeverity,
  AdvisorSuggestion,
} from '@/lib/app/questionnaire/advisor/advisor-schema';

interface AdvisorPanelProps {
  questionnaireId: string;
  graph: VersionGraphView;
}

type Phase = 'idle' | 'streaming' | 'done';

/** Badge variant for a severity. */
function severityVariant(severity: AdvisorSeverity): 'secondary' | 'default' | 'destructive' {
  if (severity === 'critical') return 'destructive';
  if (severity === 'warning') return 'default';
  return 'secondary';
}

/** Render a config value compactly for the current→proposed summary. */
function formatValue(value: unknown): string {
  if (value === null) return 'none';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : value;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return JSON.stringify(value);
}

export function AdvisorPanel({ questionnaireId, graph }: AdvisorPanelProps) {
  const router = useRouter();
  const versionId = graph.id;

  const [phase, setPhase] = useState<Phase>('idle');
  const [narrative, setNarrative] = useState('');
  const [conflicts, setConflicts] = useState<AdvisorConflict[]>([]);
  const [suggestions, setSuggestions] = useState<AdvisorSuggestion[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [applyError, setApplyError] = useState<Record<string, string>>({});
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // Set once an apply forks a launched version: `versionId` (=graph.id) is now the STALE pre-fork
  // id and the redirect to the new draft is in flight. Disable further applies so a second click
  // can't PATCH the old launched version and spawn a divergent second fork (mirrors the busy-lock
  // discipline in version-settings-panel.tsx).
  const [forkedAway, setForkedAway] = useState(false);

  const run = async () => {
    setPhase('streaming');
    setError(null);
    setNarrative('');
    setConflicts([]);
    setSuggestions([]);
    setApplied(new Set());
    setApplyError({});
    setStale(false);
    setForkedAway(false);

    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.advisorStream(questionnaireId, versionId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      });

      // A non-2xx (rate limit, flag off) returns the JSON error envelope, not a stream.
      if (!res.ok || !res.body) {
        let message: string | undefined;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          message = body.error?.message;
        } catch {
          // Non-JSON — fall through.
        }
        setError(message ?? `Advisor run failed (${res.status}). Try again.`);
        setPhase('idle');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamError: string | null = null;

      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            const ev = parsed.data as unknown as AdvisorGenEvent;
            if (ev.type === 'narrative_delta') {
              setNarrative((prev) => prev + ev.text);
            } else if (ev.type === 'analysis') {
              setConflicts(ev.conflicts);
              setSuggestions(ev.suggestions);
            } else if (ev.type === 'error') {
              streamError = ev.message;
            }
            // 'narrative_done' and 'done' need no state change here.
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (streamError) {
        // Keep any narrative already streamed; surface the failure.
        setError(streamError);
        setPhase('done');
      } else {
        setPhase('done');
      }
    } catch {
      setError('Could not run the advisor. Try again.');
      setPhase('idle');
    }
  };

  const applySuggestion = async (s: AdvisorSuggestion) => {
    setApplyingId(s.id);
    setApplyError((prev) => {
      const next = { ...prev };
      delete next[s.id];
      return next;
    });
    try {
      const { meta } = await authoringMutate(
        'PATCH',
        API.APP.QUESTIONNAIRES.versionConfig(questionnaireId, versionId),
        s.patch
      );
      setApplied((prev) => new Set(prev).add(s.id));
      setStale(true);
      if (meta?.forked) {
        // The pre-fork version id is now stale — lock out further applies until we navigate.
        setForkedAway(true);
        // Subsequent edits must target the new draft's Settings tab.
        router.replace(`/admin/questionnaires/${questionnaireId}/v/${meta.versionId}/settings`);
      }
      router.refresh();
    } catch (err) {
      const message =
        err instanceof AuthoringError || err instanceof Error
          ? err.message
          : 'Could not apply this change.';
      setApplyError((prev) => ({ ...prev, [s.id]: message }));
    } finally {
      setApplyingId(null);
    }
  };

  const streaming = phase === 'streaming';
  const showResults = phase === 'done' || (streaming && narrative.length > 0);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="flex items-center gap-1 text-lg font-semibold">
          Config Advisor
          <FieldHelp title="Config Advisor">
            <p>
              An AI review of this version&rsquo;s entire configuration — structure, goal, run-time
              settings, data slots and scoring. It describes the experience your current settings
              produce, flags conflicts, and proposes tweaks you can apply in one click. It only runs
              when you press the button, and nothing is saved until you apply a suggestion. Re-run
              it after making changes.
            </p>
          </FieldHelp>
        </h2>
        <p className="text-muted-foreground text-sm">
          Evaluate the whole questionnaire configuration for conflicts and respondent-experience
          impact, with suggested tweaks. Admin-triggered — it never runs on its own.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => void run()} disabled={streaming}>
          {streaming ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              Reviewing…
            </>
          ) : phase === 'done' ? (
            <>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Re-run advisor
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 h-4 w-4" />
              Run advisor
            </>
          )}
        </Button>
        {stale && phase === 'done' && (
          <span className="text-muted-foreground flex items-center gap-1 text-sm">
            <AlertTriangle className="h-4 w-4" />
            Settings changed — re-run the advisor for a fresh review.
          </span>
        )}
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}

      {showResults && (
        <div className="space-y-6">
          {/* Narrative */}
          {narrative.length > 0 && (
            <div
              className={cn(
                'prose prose-sm dark:prose-invert text-foreground/90 max-w-none rounded-lg border p-4',
                MARKDOWN_BLOCK_CLASSES
              )}
            >
              <Markdown remarkPlugins={[remarkGfm]}>{narrative}</Markdown>
            </div>
          )}

          {/* Conflicts */}
          {conflicts.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Conflicts</h3>
              <ul className="space-y-2">
                {conflicts.map((c, i) => (
                  <li key={i} className="rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={severityVariant(c.severity)}>{c.severity}</Badge>
                      <span className="text-sm font-medium">{c.title}</span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">{c.detail}</p>
                    {c.settings.length > 0 && (
                      <p className="text-muted-foreground mt-1 text-xs">
                        Settings: {c.settings.join(', ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Suggestions */}
          {suggestions.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Suggested tweaks</h3>
              <ul className="space-y-2">
                {suggestions.map((s) => {
                  const isApplied = applied.has(s.id);
                  return (
                    <li key={s.id} className="rounded-md border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <Badge variant={severityVariant(s.severity)}>{s.severity}</Badge>
                            <span className="text-sm font-medium">{s.title}</span>
                          </div>
                          <p className="text-muted-foreground text-sm">{s.rationale}</p>
                          <ul className="mt-1 space-y-0.5">
                            {Object.entries(s.patch).map(([field, proposed]) => (
                              <li key={field} className="text-muted-foreground font-mono text-xs">
                                {field}:{' '}
                                {formatValue(
                                  (graph.config as unknown as Record<string, unknown>)[field]
                                )}{' '}
                                → <span className="text-foreground">{formatValue(proposed)}</span>
                              </li>
                            ))}
                          </ul>
                          {applyError[s.id] && (
                            <p className="text-destructive text-xs">{applyError[s.id]}</p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant={isApplied ? 'secondary' : 'default'}
                          disabled={isApplied || applyingId === s.id || forkedAway}
                          onClick={() => void applySuggestion(s)}
                        >
                          {isApplied ? (
                            <>
                              <Check className="mr-1 h-3.5 w-3.5" />
                              Applied
                            </>
                          ) : applyingId === s.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            'Apply'
                          )}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {phase === 'done' && conflicts.length === 0 && suggestions.length === 0 && !error && (
            <p className="text-muted-foreground text-sm">
              No conflicts or tweaks suggested — this configuration looks sound.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
