'use client';

/**
 * Routing dry-run panel.
 *
 * Runs the full three-tier resolution against a real completed session and shows what would
 * happen — without creating anything. The point is that an author can tune criteria against
 * evidence rather than guessing, so the result deliberately shows the FILLS the decision was made
 * from alongside the decision itself: a verdict without its inputs is not something you can tune.
 */

import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { FieldHelp } from '@/components/ui/field-help';
import type { RoutingDecision } from '@/lib/app/questionnaire/experiences/types';

interface PreviewResult {
  decision: RoutingDecision;
  costUsd: number;
  carriedFills: Array<{
    key: string;
    name: string;
    paraphrase: string | null;
    confidence: number | null;
  }>;
  candidateKeys: string[];
}

/** How the decision was reached — the distinction an author most needs to see. */
const SOURCE_LABELS: Record<RoutingDecision['source'], string> = {
  rule: 'A rule decided this',
  llm: 'The AI selector decided this',
  fallback: 'The fallback decided this',
  budget: 'The run budget forced this',
};

export function RoutingPreviewPanel({ experienceId }: { experienceId: string }) {
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiClient.post<PreviewResult>(
        API.APP.EXPERIENCES.previewRouting(experienceId),
        { body: { sessionId: sessionId.trim() } }
      );
      setResult(data);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not run the routing preview.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card space-y-4 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1 font-medium">
          Try it against a real session
          <FieldHelp title="Routing dry-run">
            <p>
              Runs the rules, then the AI selector, then the fallback — exactly as a live handoff
              would — against a session that has already finished. Nothing is created and no
              respondent is affected.
            </p>
            <p className="mt-2">
              Use it to check that your &ldquo;choose when&rdquo; criteria actually produce the
              route you expect, before anyone meets them.
            </p>
          </FieldHelp>
        </h3>
        <p className="text-muted-foreground text-sm">
          Paste the id of a completed session from any questionnaire in this journey.
        </p>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="preview-session" className="text-xs">
            Session id
          </Label>
          <Input
            id="preview-session"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="cl…"
            disabled={busy}
          />
        </div>
        <Button onClick={() => void run()} disabled={busy || sessionId.trim() === ''}>
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          Run
        </Button>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      {result && (
        <div className="space-y-4 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={result.decision.decision === 'route' ? 'default' : 'secondary'}>
              {result.decision.decision === 'route'
                ? `Route → ${result.decision.selectedStepKey}`
                : 'Conclude with a report'}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {SOURCE_LABELS[result.decision.source]}
            </span>
            {result.decision.source === 'llm' && (
              <span className="text-muted-foreground text-xs tabular-nums">
                confidence {result.decision.confidence.toFixed(2)}
              </span>
            )}
            {result.costUsd > 0 && (
              <span className="text-muted-foreground text-xs tabular-nums">
                ${result.costUsd.toFixed(4)}
              </span>
            )}
          </div>

          <div>
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Why</p>
            <p className="mt-1 text-sm">{result.decision.rationale}</p>
          </div>

          <div>
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              What the respondent would be told
            </p>
            <p className="mt-1 text-sm italic">&ldquo;{result.decision.respondentMessage}&rdquo;</p>
          </div>

          <div>
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              What it read ({result.carriedFills.length})
            </p>
            {result.carriedFills.length === 0 ? (
              <p className="text-muted-foreground mt-1 text-sm">
                Nothing was carried — that session captured no data slots, so the selector had no
                evidence to work from.
              </p>
            ) : (
              <ul className="mt-1 space-y-1 text-sm">
                {result.carriedFills.map((fill) => (
                  <li key={fill.key} className="flex gap-2">
                    <code className="bg-muted h-fit shrink-0 rounded px-1.5 py-0.5 text-xs">
                      {fill.key}
                    </code>
                    <span className="text-muted-foreground">{fill.paraphrase ?? '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
