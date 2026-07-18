'use client';

/**
 * SessionFilters — the URL-driven filter bar for the alpha Sessions browser.
 *
 * Every control writes to the URL (via `router.replace(..., { scroll: false })`), so the SSR page
 * re-seeds, the state is shareable + back-button-safe, and — crucially — opening a session and
 * returning restores the exact filter/page position. Mirrors `analytics-filters.tsx`'s `push(mutate)`
 * helper. The support-reference search is debounced; every other control commits immediately.
 *
 * Options (clients / questionnaires / cohorts / rounds) are seeded once by the page. The round select
 * narrows to the chosen cohort; changing the cohort drops an out-of-scope round.
 */

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FilterX, SlidersHorizontal } from 'lucide-react';

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
import { SESSION_STATUSES } from '@/lib/app/questionnaire/types';
import {
  CLIENT_UNASSIGNED,
  ROUND_NONE,
} from '@/lib/app/questionnaire/admin-session-filter-constants';
import type { AdminSessionFilterOptions } from '@/app/api/v1/app/questionnaire-sessions/_lib/admin-session-list';

/** Sentinel for the "any / all" option — Radix Select can't hold an empty-string value. */
const ALL = 'all';

/** The filter keys this bar owns in the URL (page/sort are owned by the browser). */
const FILTER_KEYS = [
  'q',
  'status',
  'isPreview',
  'demoClientId',
  'questionnaireId',
  'cohortId',
  'roundId',
  'from',
  'to',
] as const;

export interface SessionFiltersProps {
  options: AdminSessionFilterOptions;
}

export function SessionFilters({ options }: SessionFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const get = (key: string) => searchParams.get(key) ?? '';

  /** Clone params, mutate, and reset to page 1 (a filter change invalidates the current page). */
  const push = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    params.delete('page');
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const setParam = (key: string, value: string, clearWhen: string) =>
    push((params) => {
      if (value && value !== clearWhen) params.set(key, value);
      else params.delete(key);
    });

  // Support-reference search: live local input, debounced into the URL so we don't push per keystroke.
  const [refSearch, setRefSearch] = useState(get('q'));
  const urlQ = get('q');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last value THIS component pushed. Our own debounced push echoes back through the URL a few
  // hundred ms later (it's a server round-trip); without this guard the sync effect below would
  // overwrite whatever the user typed in the meantime, visibly snapping characters away.
  const lastPushed = useRef<string | null>(null);

  // Keep the input in sync when the URL changes EXTERNALLY (Clear all, back-button) — not when it
  // changes because of our own push.
  useEffect(() => {
    if (lastPushed.current !== null && urlQ === lastPushed.current) return;
    setRefSearch(urlQ);
  }, [urlQ]);

  // Don't leave a pending push to fire after unmount.
  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    []
  );

  const onRefChange = (value: string) => {
    setRefSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      lastPushed.current = value.trim();
      setParam('q', value.trim(), '');
    }, 350);
  };

  const cohortId = get('cohortId');
  // Round options narrow to the selected cohort; without one, every round is offered.
  const roundChoices = cohortId
    ? options.rounds.filter((r) => r.cohortId === cohortId)
    : options.rounds;

  const setCohort = (value: string) =>
    push((params) => {
      if (value && value !== ALL) params.set('cohortId', value);
      else params.delete('cohortId');
      // A round only makes sense within its cohort — drop a now-out-of-scope round.
      const round = params.get('roundId');
      if (
        round &&
        round !== ROUND_NONE &&
        !options.rounds.some((r) => r.id === round && (value === ALL || r.cohortId === value))
      ) {
        params.delete('roundId');
      }
    });

  const activeCount = FILTER_KEYS.filter((k) => searchParams.get(k)).length;

  const clearAll = () =>
    push((params) => {
      for (const k of FILTER_KEYS) params.delete(k);
    });

  return (
    <div className="bg-card rounded-xl border shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Filters
          {activeCount > 0 && (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--cq-accent)] px-1 text-[10px] font-bold text-[color:var(--cq-accent-foreground)] tabular-nums">
              {activeCount}
            </span>
          )}
        </div>
        {activeCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors"
          >
            <FilterX className="h-3.5 w-3.5" aria-hidden="true" />
            Clear all
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3 p-4">
        <FilterField label="Support reference" htmlFor="ref-search">
          <Input
            id="ref-search"
            value={refSearch}
            onChange={(e) => onRefChange(e.target.value)}
            placeholder="e.g. 7F3K9M2P"
            className="w-44 font-mono"
          />
        </FilterField>

        <FilterField label="Status" htmlFor="status-filter">
          <Select value={get('status') || ALL} onValueChange={(v) => setParam('status', v, ALL)}>
            <SelectTrigger id="status-filter" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {SESSION_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterField>

        <FilterField
          label="Type"
          htmlFor="type-filter"
          help={{
            title: 'Real vs preview',
            body: 'Preview sessions are admin rehearsals (excluded from analytics) and are hidden by default. Switch to “Preview only” or “All” to include them.',
          }}
        >
          <Select
            value={get('isPreview') || 'false'}
            onValueChange={(v) => setParam('isPreview', v, 'false')}
          >
            <SelectTrigger id="type-filter" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="false">Real only</SelectItem>
              <SelectItem value="true">Preview only</SelectItem>
              <SelectItem value="all">All (incl. preview)</SelectItem>
            </SelectContent>
          </Select>
        </FilterField>

        {options.questionnaires.length > 0 && (
          <FilterField label="Questionnaire" htmlFor="questionnaire-filter">
            <Select
              value={get('questionnaireId') || ALL}
              onValueChange={(v) => setParam('questionnaireId', v, ALL)}
            >
              <SelectTrigger id="questionnaire-filter" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All questionnaires</SelectItem>
                <SelectSeparator />
                {options.questionnaires.map((q) => (
                  <SelectItem key={q.id} value={q.id}>
                    {q.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
        )}

        {(options.clients.length > 0 || options.hasUnassignedClient) && (
          <FilterField
            label="Client"
            htmlFor="client-filter"
            help={{
              title: 'Attributed client',
              body: 'The demo client the questionnaire belongs to. “Unassigned” covers questionnaires with no client.',
            }}
          >
            <Select
              value={get('demoClientId') || ALL}
              onValueChange={(v) => setParam('demoClientId', v, ALL)}
            >
              <SelectTrigger id="client-filter" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All clients</SelectItem>
                <SelectSeparator />
                {options.clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
                {options.hasUnassignedClient && (
                  <SelectItem value={CLIENT_UNASSIGNED}>Unassigned</SelectItem>
                )}
              </SelectContent>
            </Select>
          </FilterField>
        )}

        {options.cohorts.length > 0 && (
          <FilterField
            label="Cohort"
            htmlFor="cohort-filter"
            help={{
              title: 'Cohort',
              body: 'A named group of respondents belonging to a client. Filters to sessions run by that cohort’s members or rounds.',
            }}
          >
            <Select value={cohortId || ALL} onValueChange={setCohort}>
              <SelectTrigger id="cohort-filter" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All cohorts</SelectItem>
                <SelectSeparator />
                {options.cohorts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} · {c.clientName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
        )}

        {(roundChoices.length > 0 || options.hasOpenEnded) && (
          <FilterField
            label="Round"
            htmlFor="round-filter"
            help={{
              title: 'Round',
              body: 'A time-bound delivery of a questionnaire to a cohort. “Open-ended” covers sessions started outside any round.',
            }}
          >
            <Select
              value={get('roundId') || ALL}
              onValueChange={(v) => setParam('roundId', v, ALL)}
            >
              <SelectTrigger id="round-filter" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All rounds</SelectItem>
                {(roundChoices.length > 0 || options.hasOpenEnded) && <SelectSeparator />}
                {roundChoices.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
                {options.hasOpenEnded && <SelectItem value={ROUND_NONE}>Open-ended</SelectItem>}
              </SelectContent>
            </Select>
          </FilterField>
        )}

        <FilterField label="From" htmlFor="from-filter">
          <Input
            id="from-filter"
            type="date"
            value={get('from')}
            max={get('to') || undefined}
            onChange={(e) => setParam('from', e.target.value, '')}
            className="w-40"
          />
        </FilterField>

        <FilterField label="To" htmlFor="to-filter">
          <Input
            id="to-filter"
            type="date"
            value={get('to')}
            min={get('from') || undefined}
            onChange={(e) => setParam('to', e.target.value, '')}
            className="w-40"
          />
        </FilterField>
      </div>
    </div>
  );
}

/** A labelled filter control with an optional ⓘ help popover. */
function FilterField({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor?: string;
  help?: { title: string; body: string };
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-muted-foreground flex items-center gap-1 text-xs">
        {label}
        {help && <FieldHelp title={help.title}>{help.body}</FieldHelp>}
      </Label>
      {children}
    </div>
  );
}
