'use client';

/**
 * Look a chat up by its support reference, then re-evaluate its saved turns.
 *
 * An admin pastes the ref a respondent quoted ("7F3K-9M2P"); this resolves the session and lists
 * its turns. Any turn with saved inspector traces can be evaluated on the spot (the evaluator runs
 * over the exact calls that turn made). The score appears inline and expands to the full verdict —
 * the shared {@link TurnEvaluationVerdict} (sub-scores + Markdown body + Copy/Download) plus the
 * {@link TurnEvaluationReview} controls (comment, learning flag, send-to-dataset) — so the reviewer
 * can read, download, and action the evaluation without leaving the panel. The forgiving
 * normalisation lives server-side, so a dash, lower-case, or an O/0 slip still resolves.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Search, Gauge, ChevronDown, ChevronRight, ScanSearch } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';
import type { RefLookupResult } from '@/lib/app/questionnaire/views';
import type { TurnEvaluation } from '@/lib/app/questionnaire/turn-evaluation/schema';
import { TurnEvaluationVerdict } from '@/components/app/questionnaire/turn-evaluation/turn-evaluation-verdict';
import { TurnEvaluationReview } from '@/components/app/questionnaire/turn-evaluation/turn-evaluation-review';
import { DiagnosticsInspectorCalls } from '@/components/admin/questionnaires/diagnostics/inspector-calls';

/** Per-turn evaluation state keyed by ordinal. */
type TurnEvalState =
  | { status: 'idle' }
  | { status: 'running' }
  | {
      status: 'done';
      score: number;
      evaluationId: string | null;
      verdict: TurnEvaluation;
      model: string;
    }
  | { status: 'error'; message: string };

export interface RefLookupPanelProps {
  /**
   * Resolve this reference on mount instead of waiting for the admin to type one — used when the
   * session is already known (e.g. embedded in the Sessions drawer's Evaluations tab).
   */
  initialRef?: string;
  /**
   * Embedded mode: drop the card chrome, the heading and the lookup form, leaving just the resolved
   * turns + their evaluate/verdict controls. Requires {@link initialRef}.
   */
  embedded?: boolean;
}

export function RefLookupPanel({ initialRef, embedded = false }: RefLookupPanelProps = {}) {
  const [refInput, setRefInput] = useState(initialRef ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RefLookupResult | null>(null);
  const [evalState, setEvalState] = useState<Record<number, TurnEvalState>>({});
  // Which evaluated turns have their full verdict expanded (keyed by ordinal).
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // Which turns have their raw agent calls (prompts + responses) expanded (keyed by ordinal).
  const [callsExpanded, setCallsExpanded] = useState<Record<number, boolean>>({});

  const lookupRef = useCallback(async (raw: string) => {
    const ref = raw.trim();
    if (!ref) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setEvalState({});
    setExpanded({});
    setCallsExpanded({});
    try {
      const data = await apiClient.get<RefLookupResult>(API.APP.TURN_EVALUATIONS.byRef(ref));
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No chat found for that reference');
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-resolve when the caller already knows the session (embedded use).
  useEffect(() => {
    if (initialRef) void lookupRef(initialRef);
  }, [initialRef, lookupRef]);

  const lookup = () => lookupRef(refInput);

  async function evaluateTurn(ordinal: number) {
    if (!result) return;
    setEvalState((s) => ({ ...s, [ordinal]: { status: 'running' } }));
    try {
      const data = await apiClient.post<{
        verdict: TurnEvaluation;
        model: string;
        evaluationId: string | null;
      }>(API.APP.QUESTIONNAIRE_SESSIONS.evaluateSavedTurn(result.session.id, ordinal));
      setEvalState((s) => ({
        ...s,
        [ordinal]: {
          status: 'done',
          score: data.verdict.overallScore,
          evaluationId: data.evaluationId,
          verdict: data.verdict,
          model: data.model,
        },
      }));
      // Reveal the freshly-scored verdict so the result is visible without an extra click.
      setExpanded((e) => ({ ...e, [ordinal]: true }));
    } catch (err) {
      setEvalState((s) => ({
        ...s,
        [ordinal]: {
          status: 'error',
          message: err instanceof Error ? err.message : 'Evaluation failed',
        },
      }));
    }
  }

  return (
    <div className={embedded ? 'space-y-4' : 'bg-card space-y-4 rounded-lg border p-4'}>
      {!embedded && (
        <>
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Look up a chat by reference</h2>
            <p className="text-muted-foreground text-xs">
              Paste the reference a respondent quoted (e.g.{' '}
              <span className="font-mono">7F3K-9M2P</span>) to open their conversation and
              re-evaluate any turn against the calls it actually ran.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void lookup();
            }}
            className="flex items-center gap-2"
          >
            <input
              value={refInput}
              onChange={(e) => setRefInput(e.target.value)}
              placeholder="7F3K-9M2P"
              aria-label="Support reference"
              className="w-48 rounded border px-2 py-1.5 font-mono text-sm"
            />
            <button
              type="submit"
              disabled={loading || !refInput.trim()}
              className="bg-muted hover:bg-muted/70 inline-flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Look up
            </button>
          </form>
        </>
      )}

      {embedded && loading && (
        <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading turns…
        </div>
      )}

      {error && (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-3">
          {/* The drawer's own header already identifies the session, so skip this when embedded. */}
          {!embedded && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="font-mono font-semibold">
                {formatSessionRef(result.session.ref)}
              </span>
              <span className="text-muted-foreground">
                {result.session.questionnaireTitle ?? '—'}
                {result.session.versionNumber !== null && ` · v${result.session.versionNumber}`}
              </span>
              <span className="bg-muted rounded px-2 py-0.5 text-xs">{result.session.status}</span>
              {result.session.isPreview && (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                  preview
                </span>
              )}
              <span className="text-muted-foreground text-xs">
                {new Date(result.session.createdAt).toLocaleString()}
              </span>
            </div>
          )}

          {result.turns.length === 0 ? (
            <p className="text-muted-foreground text-sm">This chat has no recorded turns.</p>
          ) : (
            <ol className="space-y-2">
              {result.turns.map((turn) => {
                const state = evalState[turn.ordinal] ?? { status: 'idle' };
                return (
                  <li key={turn.ordinal} className="rounded border p-3 text-sm">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-semibold">Turn {turn.ordinal}</span>
                      <span className="text-muted-foreground text-xs">
                        {turn.hasTraces ? `${turn.callCount} calls` : 'no saved traces'}
                        {turn.evaluationCount > 0 && ` · ${turn.evaluationCount} prior`}
                      </span>
                    </div>
                    {/* Interviewer first: the conversation opens with the interviewer, so the
                        first turn has no respondent line. Each line is omitted when its side
                        said nothing this turn (rather than rendering a bare dash). The full text
                        is shown (not truncated) with newlines preserved. */}
                    {turn.agentResponse && (
                      <p className="text-muted-foreground whitespace-pre-wrap">
                        <span className="text-foreground font-medium">Interviewer:</span>{' '}
                        {turn.agentResponse}
                      </p>
                    )}
                    {turn.userMessage && (
                      <p className="text-muted-foreground whitespace-pre-wrap">
                        <span className="text-foreground font-medium">Respondent:</span>{' '}
                        {turn.userMessage}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void evaluateTurn(turn.ordinal)}
                        disabled={!turn.hasTraces || state.status === 'running'}
                        title={
                          turn.hasTraces ? undefined : 'No saved inspector traces for this turn'
                        }
                        className="hover:bg-muted inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {state.status === 'running' ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Gauge className="h-3 w-3" />
                        )}
                        Evaluate
                      </button>
                      {turn.hasTraces && (
                        <button
                          type="button"
                          onClick={() =>
                            setCallsExpanded((c) => ({ ...c, [turn.ordinal]: !c[turn.ordinal] }))
                          }
                          aria-expanded={callsExpanded[turn.ordinal] ?? false}
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium"
                        >
                          {callsExpanded[turn.ordinal] ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          <ScanSearch className="h-3 w-3" />
                          {callsExpanded[turn.ordinal] ? 'Hide' : 'Show'} raw calls (
                          {turn.callCount})
                        </button>
                      )}
                      {state.status === 'done' && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((e) => ({ ...e, [turn.ordinal]: !e[turn.ordinal] }))
                          }
                          aria-expanded={expanded[turn.ordinal] ?? false}
                          className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
                        >
                          {expanded[turn.ordinal] ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          Scored {state.score}/100 · {expanded[turn.ordinal] ? 'Hide' : 'View'}{' '}
                          evaluation
                        </button>
                      )}
                      {state.status === 'error' && (
                        <span className="text-xs text-red-700">{state.message}</span>
                      )}
                    </div>

                    {turn.hasTraces && callsExpanded[turn.ordinal] && (
                      <div className="mt-3 border-t pt-3">
                        <DiagnosticsInspectorCalls calls={turn.calls} />
                      </div>
                    )}

                    {state.status === 'done' && expanded[turn.ordinal] && (
                      <div className="mt-3 space-y-3 border-t pt-3">
                        <TurnEvaluationVerdict
                          verdict={state.verdict}
                          model={state.model}
                          turnIndex={turn.ordinal - 1}
                        />
                        {state.evaluationId && (
                          <TurnEvaluationReview
                            sessionId={result.session.id}
                            evaluationId={state.evaluationId}
                            initialFlagStatus="none"
                            initialComment={null}
                          />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
