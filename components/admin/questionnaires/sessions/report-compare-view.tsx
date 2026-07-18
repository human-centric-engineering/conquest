'use client';

/**
 * ReportCompareView — a side-by-side word diff of two respondent-report revisions.
 *
 * The admin picks a left and right entry (the "Original" baseline or any ready re-run); each side's
 * content is fetched via the revision-detail endpoint, flattened to prose, and word-diffed. The left
 * column highlights removed text, the right column highlights added text — so an admin can see exactly
 * what a re-run changed before promoting it.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { diffWords, type DiffSegment } from '@/lib/utils/word-diff';
import type { RespondentReportContent } from '@/lib/app/questionnaire/report/content';

/** One comparable entry — a ready revision (0 = Original). */
export interface CompareEntry {
  revisionNumber: number;
  label: string;
}

interface RevisionDetail {
  revisionNumber: number;
  content: RespondentReportContent | null;
}

export interface ReportCompareViewProps {
  sessionId: string;
  entries: CompareEntry[];
  initialA: number;
  initialB: number;
}

export function ReportCompareView({
  sessionId,
  entries,
  initialA,
  initialB,
}: ReportCompareViewProps) {
  const [aRev, setARev] = useState(initialA);
  const [bRev, setBRev] = useState(initialB);
  const [a, setA] = useState<RevisionDetail | null>(null);
  const [b, setB] = useState<RevisionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [ra, rb] = await Promise.all([
          apiClient.get<RevisionDetail>(
            API.APP.QUESTIONNAIRE_SESSIONS.reportRevision(sessionId, aRev)
          ),
          apiClient.get<RevisionDetail>(
            API.APP.QUESTIONNAIRE_SESSIONS.reportRevision(sessionId, bRev)
          ),
        ]);
        if (!cancelled) {
          setA(ra);
          setB(rb);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof APIClientError ? err.message : 'Could not load the comparison.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, aRev, bRev]);

  const diff = useMemo(
    () =>
      a?.content && b?.content ? diffWords(flattenReport(a.content), flattenReport(b.content)) : [],
    [a, b]
  );
  const labelFor = (rev: number) =>
    entries.find((e) => e.revisionNumber === rev)?.label ?? `#${rev}`;

  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-end gap-3">
        <RevisionSelect id="cmp-a" label="Left" value={aRev} entries={entries} onChange={setARev} />
        <span className="text-muted-foreground pb-2 text-xs">vs</span>
        <RevisionSelect
          id="cmp-b"
          label="Right"
          value={bRev}
          entries={entries}
          onChange={setBRev}
        />
        <p className="text-muted-foreground pb-2 text-xs">
          <span className="rounded bg-rose-100 px-1 text-rose-700 line-through dark:bg-rose-950/50 dark:text-rose-300">
            removed
          </span>{' '}
          <span className="rounded bg-emerald-100 px-1 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
            added
          </span>
        </p>
      </div>

      {loading ? (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading comparison…
        </div>
      ) : error ? (
        <p className="text-destructive py-12 text-center text-sm">{error}</p>
      ) : aRev === bRev ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          Pick two different versions to compare.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <DiffColumn title={labelFor(aRev)} segments={diff} side="left" />
          <DiffColumn title={labelFor(bRev)} segments={diff} side="right" />
        </div>
      )}
    </div>
  );
}

function RevisionSelect({
  id,
  label,
  value,
  entries,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  entries: CompareEntry[];
  onChange: (rev: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger id={id} className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {entries.map((e) => (
            <SelectItem key={e.revisionNumber} value={String(e.revisionNumber)}>
              {e.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** One side of the diff: unchanged text plus this side's changes (removals on the left, additions on the right). */
function DiffColumn({
  title,
  segments,
  side,
}: {
  title: string;
  segments: DiffSegment[];
  side: 'left' | 'right';
}) {
  const drop = side === 'left' ? 'ins' : 'del';
  const changeType = side === 'left' ? 'del' : 'ins';
  return (
    <div className="rounded-lg border">
      <div className="bg-muted/50 border-b px-3 py-1.5 text-xs font-semibold">{title}</div>
      <div className="max-h-[52vh] overflow-y-auto p-3 text-sm leading-relaxed whitespace-pre-wrap">
        {segments
          .filter((s) => s.type !== drop)
          .map((s, i) =>
            s.type === changeType ? (
              <span
                key={i}
                className={cn(
                  'rounded',
                  side === 'left'
                    ? 'bg-rose-100 text-rose-800 line-through dark:bg-rose-950/50 dark:text-rose-300'
                    : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                )}
              >
                {s.text}
              </span>
            ) : (
              <span key={i}>{s.text}</span>
            )
          )}
      </div>
    </div>
  );
}

/** Flatten a report's structured content to comparable prose (summary → sections → next steps). */
function flattenReport(content: RespondentReportContent): string {
  const parts: string[] = [content.summary ?? ''];
  for (const s of content.sections) parts.push(`\n\n${s.heading}\n${s.body}`);
  if (content.actions.length > 0) {
    parts.push(`\n\nNext steps\n${content.actions.map((x) => `• ${x}`).join('\n')}`);
  }
  return parts.join('');
}
