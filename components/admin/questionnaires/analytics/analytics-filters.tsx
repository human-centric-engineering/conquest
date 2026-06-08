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
import { TagChip } from '@/components/admin/questionnaires/tag-chip';
import { cn } from '@/lib/utils';
import type { TagView } from '@/lib/app/questionnaire/views';

export interface AnalyticsFiltersProps {
  tagVocabulary: TagView[];
  filters: { from: string; to: string; tagIds: string[] };
}

export function AnalyticsFilters({ tagVocabulary, filters }: AnalyticsFiltersProps) {
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
