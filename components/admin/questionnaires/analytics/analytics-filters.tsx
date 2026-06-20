'use client';

/**
 * Shared scope/filter control for the F8.1 analytics views.
 *
 * Drives the date window and tag filter through the URL (so the SSR page re-fetches
 * and the filter state is shareable/back-button-safe), preserving the `?v=` version
 * selection the page owns. The tag filter only affects the distributions view; the
 * funnel and cost views ignore `tagIds`.
 */

import { useRouter, usePathname, useSearchParams } from 'next/navigation';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TagChip } from '@/components/admin/questionnaires/tag-chip';
import { cn } from '@/lib/utils';
import type { TagView } from '@/lib/app/questionnaire/views';

/** One round the analytics can be scoped to (a cohort's run of this questionnaire). */
export interface AnalyticsRoundChoice {
  id: string;
  name: string;
  cohortName: string;
}

/** Sentinel select values for the round scope (real round ids are cuids, so no collision). */
const ROUND_ALL = '__all__';
const ROUND_NONE = 'none';

export interface AnalyticsFiltersProps {
  tagVocabulary: TagView[];
  filters: { from: string; to: string; tagIds: string[]; roundId?: string };
  /** Rounds that produced sessions for this version; empty hides the round selector. */
  roundOptions: AnalyticsRoundChoice[];
  /** Whether any non-round (open-ended) sessions exist (gates the "No round" option). */
  hasOpenEnded: boolean;
}

export function AnalyticsFilters({
  tagVocabulary,
  filters,
  roundOptions,
  hasOpenEnded,
}: AnalyticsFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const push = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const setDate = (key: 'from' | 'to', value: string) =>
    push((params) => {
      if (value) params.set(key, value);
      else params.delete(key);
    });

  const setRound = (value: string) =>
    push((params) => {
      if (value === ROUND_ALL) params.delete('roundId');
      else params.set('roundId', value);
    });

  const showRoundFilter = roundOptions.length > 0 || hasOpenEnded;

  const toggleTag = (tagId: string) =>
    push((params) => {
      const next = new Set(filters.tagIds);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      if (next.size > 0) params.set('tagIds', [...next].join(','));
      else params.delete('tagIds');
    });

  const clearTags = () =>
    push((params) => {
      params.delete('tagIds');
    });

  const selected = new Set(filters.tagIds);

  return (
    <div className="bg-card space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="analytics-from" className="flex items-center gap-1 text-xs">
            From
            <FieldHelp title="Window start">
              Sessions and cost from this date are included (inclusive).
            </FieldHelp>
          </Label>
          <Input
            id="analytics-from"
            type="date"
            value={filters.from}
            max={filters.to}
            onChange={(e) => setDate('from', e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="analytics-to" className="flex items-center gap-1 text-xs">
            To
            <FieldHelp title="Window end">
              The window runs up to the end of this date. Defaults to today.
            </FieldHelp>
          </Label>
          <Input
            id="analytics-to"
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => setDate('to', e.target.value)}
            className="w-40"
          />
        </div>

        {showRoundFilter && (
          <div className="space-y-1">
            <Label className="flex items-center gap-1 text-xs">
              Round
              <FieldHelp title="Scope to a round">
                Isolate one cohort&rsquo;s run of this questionnaire. Each round is a separate
                cohort over a set window, so analysing them together would blend different groups.
                &ldquo;All sessions&rdquo; shows every respondent across all rounds.
              </FieldHelp>
            </Label>
            <Select value={filters.roundId ?? ROUND_ALL} onValueChange={setRound}>
              <SelectTrigger className="w-64" aria-label="Round scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROUND_ALL}>All sessions</SelectItem>
                {(roundOptions.length > 0 || hasOpenEnded) && <SelectSeparator />}
                {roundOptions.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} · {r.cohortName}
                  </SelectItem>
                ))}
                {hasOpenEnded && <SelectItem value={ROUND_NONE}>No round (open-ended)</SelectItem>}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {tagVocabulary.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground text-xs font-medium">
              Filter questions by tag
            </span>
            <FieldHelp title="Tag filter">
              Restricts the per-question distributions to questions carrying any selected tag. Does
              not affect the funnel or cost views.
            </FieldHelp>
            {selected.size > 0 && (
              <button
                type="button"
                onClick={clearTags}
                className="text-muted-foreground hover:text-foreground ml-2 text-xs underline"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tagVocabulary.map((tag) => {
              const isOn = selected.has(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleTag(tag.id)}
                  aria-pressed={isOn}
                  className={cn(
                    'rounded-full transition',
                    isOn ? 'ring-primary ring-2 ring-offset-1' : 'opacity-70 hover:opacity-100'
                  )}
                >
                  <TagChip tag={tag} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
