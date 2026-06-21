'use client';

/**
 * Learning Mode manager for a round.
 *
 * Owns the round's `learningEnabled` toggle and `minRespondents` (k-anonymity) control, shows a
 * prominent bias warning, previews the current peer-theme digest (insight + respondent count +
 * divergence band + when it was built), and offers a manual rebuild. Every mutation hits the API then
 * `router.refresh()`. Styling matches the sibling context panel — restrained, accent-token-driven.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, RefreshCw, Sparkles, Users } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { FieldHelp } from '@/components/ui/field-help';
import { MIN_RESPONDENTS_FLOOR } from '@/lib/app/questionnaire/rounds';
import type { BriefableQuestionnaire, LearningConfigShape } from '@/lib/app/questionnaire/rounds';
import type { LearningDigestRow } from '@/lib/app/questionnaire/learning/digest';

function divergenceBand(d: number | null): { label: string; className: string } {
  if (d === null) return { label: '—', className: 'bg-muted text-muted-foreground' };
  if (d >= 0.66) return { label: 'High split', className: 'bg-amber-500/15 text-amber-600' };
  if (d >= 0.33) return { label: 'Some split', className: 'bg-muted text-muted-foreground' };
  return { label: 'Consensus', className: 'bg-muted text-muted-foreground' };
}

export interface RoundLearningPanelProps {
  roundId: string;
  learningEnabled: boolean;
  learningConfig: LearningConfigShape;
  digest: LearningDigestRow[];
  briefable: BriefableQuestionnaire[];
}

export function RoundLearningPanel({
  roundId,
  learningEnabled,
  learningConfig,
  digest,
  briefable,
}: RoundLearningPanelProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(learningEnabled);
  const [minRespondents, setMinRespondents] = useState(String(learningConfig.minRespondents));
  const [togglePending, setTogglePending] = useState(false);
  const [savingMin, setSavingMin] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleByVersion = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of briefable) map.set(b.versionId, b.title);
    return map;
  }, [briefable]);

  const refreshedLabel = useMemo(() => {
    if (digest.length === 0) return null;
    const newest = digest.reduce((a, b) => (a.refreshedAt > b.refreshedAt ? a : b)).refreshedAt;
    return new Date(newest).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [digest]);

  const toggle = async (next: boolean) => {
    setTogglePending(true);
    setError(null);
    setEnabled(next);
    try {
      await apiClient.patch(API.APP.ROUNDS.byId(roundId), { body: { learningEnabled: next } });
      router.refresh();
    } catch (err) {
      setEnabled(!next);
      setError(err instanceof APIClientError ? err.message : 'Could not update the setting.');
    } finally {
      setTogglePending(false);
    }
  };

  const saveMin = async () => {
    const n = Number(minRespondents);
    if (!Number.isInteger(n) || n < MIN_RESPONDENTS_FLOOR) {
      setError(`The minimum must be a whole number of at least ${MIN_RESPONDENTS_FLOOR}.`);
      setMinRespondents(String(learningConfig.minRespondents));
      return;
    }
    if (n === learningConfig.minRespondents) return;
    setSavingMin(true);
    setError(null);
    try {
      await apiClient.patch(API.APP.ROUNDS.byId(roundId), {
        body: { learningConfig: { minRespondents: n } },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not save the threshold.');
    } finally {
      setSavingMin(false);
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    setError(null);
    try {
      await apiClient.post(API.APP.ROUNDS.learningRebuild(roundId), { body: {} });
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not rebuild the digest.');
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Bias warning — always visible, the defining caveat of this feature. */}
      <div className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="space-y-0.5 text-xs">
          <p className="font-semibold text-amber-700 dark:text-amber-400">
            Learning Mode introduces bias by design
          </p>
          <p className="text-muted-foreground">
            Later respondents are gently shown generalised themes from earlier ones, which can nudge
            their answers and reduce independence. Use it to deepen conversations, not to measure an
            unbiased population. Themes are anonymised and only appear once enough respondents have
            completed.
          </p>
        </div>
      </div>

      {/* Toggle */}
      <div className="flex items-start justify-between gap-4 rounded-lg border px-4 py-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            Enable Learning Mode
            <FieldHelp title="Learning Mode">
              When on, the interviewer may gently reference what earlier respondents (in aggregate)
              tended to say, and — with the adaptive strategy — probe topics they disagreed on more
              deeply. Off by default.
            </FieldHelp>
          </div>
          <p className="text-muted-foreground text-xs">
            Let prior answers in this round subtly shape later interviews.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {togglePending && <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void toggle(v)}
            disabled={togglePending}
            aria-label="Enable Learning Mode for this round"
          />
        </div>
      </div>

      {/* k-anonymity threshold */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            Minimum respondents
            <FieldHelp title="k-anonymity threshold">
              No themes are shown until at least this many respondents have completed — both overall
              and for each individual topic. Higher is safer against identifying any one person.
              Minimum {MIN_RESPONDENTS_FLOOR}.
            </FieldHelp>
          </div>
          <Input
            type="number"
            min={MIN_RESPONDENTS_FLOOR}
            value={minRespondents}
            onChange={(e) => setMinRespondents(e.target.value)}
            onBlur={() => void saveMin()}
            className="w-28"
            aria-label="Minimum respondents before themes appear"
            disabled={savingMin}
          />
        </div>
        {savingMin && (
          <span className="text-muted-foreground inline-flex items-center gap-1 pb-2 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving…
          </span>
        )}
      </div>

      {/* Digest preview */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-[color:var(--cq-accent)]" /> Current themes
            {refreshedLabel && (
              <span className="text-muted-foreground text-xs font-normal">
                · updated {refreshedLabel}
              </span>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => void rebuild()} disabled={rebuilding}>
            {rebuilding ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Rebuild
          </Button>
        </div>

        {digest.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border px-4 py-6 text-center text-xs">
            No themes yet. They appear once at least {learningConfig.minRespondents} respondents
            have completed this round&rsquo;s questionnaire(s) — then the interviewer can draw on
            them.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {digest.map((row) => {
              const band = divergenceBand(row.divergence);
              return (
                <li key={`${row.versionId}:${row.slotKind}:${row.slotKey}`} className="px-3 py-2.5">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[0.65rem] font-medium',
                        band.className
                      )}
                    >
                      {band.label}
                    </span>
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-[0.7rem]">
                      <Users className="h-3 w-3" /> {row.respondentCount}
                    </span>
                    {titleByVersion.has(row.versionId) && (
                      <span className="text-muted-foreground text-[0.7rem]">
                        {titleByVersion.get(row.versionId)}
                      </span>
                    )}
                  </div>
                  <p className="text-sm">{row.insight}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
