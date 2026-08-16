'use client';

/**
 * The routing map's detail panel — what the selected node is, and what is behind every number on it.
 *
 * Split out of `routing-map-dialog.tsx` because two of its three parts stopped being a list of label
 * and value pairs. Both changes answer the same complaint, which is the only one worth answering
 * about a read-only panel: *where did that come from?*
 *
 * ## The duration figures
 *
 * "Full depth 1m 17s" is a number with no provenance. An author cannot tell from it whether the
 * figure was measured, whether it describes the chat they will actually run, or what would make it
 * smaller. So the panel shows the arithmetic instead: the rate charged for each kind of item, how
 * many of them this topic has, and what that comes to — plus, when they differ, the members a light
 * run actually samples. Everything a reader needs to check the total by adding a column up.
 *
 * The block is **collapsed by default**, because the arithmetic is what a reader wants once and the
 * figure is what they want every time. Open, it took more vertical space than everything else in the
 * panel combined. Two things survive the collapse: the two readings, and the caveat in short form.
 *
 * It also explains **every badge the node draws**. `Fallback` and `Preferred check` are the system's
 * own vocabulary for guardrail mechanics an author met once, in a settings field, possibly weeks ago —
 * two words on a node cannot carry that, and until this section existed nothing anywhere on the map
 * said what they did. The pill is re-drawn here in the same shape and colour so a reader is not
 * matching two words by memory, and both pill and sentence come from `SCOPE_BADGES`, so a badge can
 * never reach the canvas without its explanation.
 *
 * The caveat is given the same prominence as the figure, because it is the half that is most often
 * assumed wrong: this is **answering** time, item by item. The interview is a conversation, and the
 * agent's own turns, its follow-ups and any re-asks are not in it. A real chat runs longer than the
 * estimate every time, and an author who reads the figure as a stopwatch will set a session budget
 * that cuts their instrument in half.
 *
 * ## The criteria
 *
 * The author's routing criteria arrive as free text with a list inside them, and rendering them as
 * one grey block made the reader recover that list by eye on every visit. `parseCriteria` recovers
 * it once; this file draws it. Nothing is rewritten — see that module's note on why the only things
 * moved are the bullet marker and the priority marker.
 */

import { useState } from 'react';
import { AlertTriangle, ChevronRight, PenLine } from 'lucide-react';

import { BADGE_TONES } from '@/components/admin/questionnaires/topics/routing-map-node';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import {
  parseCriteria,
  type CriteriaItem,
  type CriteriaPriority,
} from '@/lib/app/questionnaire/scope/criteria-format';
import type {
  ScopeBadgeNote,
  ScopeGraphNode,
  ScopeNodeTiming,
} from '@/lib/app/questionnaire/scope/graph';
import { cn } from '@/lib/utils';

/** Shared heading treatment: quiet, small, and the same in all three sections. */
const SECTION_LABEL = 'text-[11px] font-medium uppercase tracking-wider text-muted-foreground';

export interface RoutingMapDetailProps {
  /** The selected node, or null when nothing is selected. */
  node: ScopeGraphNode | null;
  /** Jump to this topic in the list editor. The dialog closes itself first. */
  onEditTopic: (topicKey: string) => void;
}

export function RoutingMapDetail({ node, onEditTopic }: RoutingMapDetailProps) {
  if (!node) {
    return (
      <p className="text-muted-foreground text-xs">
        Select anything on the map to see what it is and what decides it.
      </p>
    );
  }

  const { detail } = node;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{detail.title}</h3>
        <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{detail.summary}</p>
      </div>

      <dl className="space-y-1.5 text-xs">
        {detail.rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[6.5rem_1fr] gap-2">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="break-words">{row.value}</dd>
          </div>
        ))}
      </dl>

      {detail.badgeNotes && detail.badgeNotes.length > 0 ? (
        <BadgeNotesSection notes={detail.badgeNotes} />
      ) : null}

      {detail.timing ? <TimingSection timing={detail.timing} /> : null}
      {detail.criteria ? <CriteriaSection text={detail.criteria} /> : null}

      {detail.topicKey ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={() => onEditTopic(detail.topicKey as string)}
        >
          <PenLine className="mr-2 h-4 w-4" />
          Edit this topic
        </Button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* What the badges mean                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The same pill treatment the node uses, deliberately.
 *
 * A reader arrives here holding the chip they just saw on the canvas; re-drawing it as plain text would
 * make them match two words by memory. Same shape, same colour, sentence beside it.
 */
function BadgeNotesSection({ notes }: { notes: ScopeBadgeNote[] }) {
  return (
    <section className="bg-card space-y-2 rounded-lg border p-3" data-testid="routing-map-badges">
      <h4 className={SECTION_LABEL}>What the tags mean</h4>
      <ul className="space-y-2">
        {notes.map((note) => (
          <li key={note.label} className="space-y-1">
            <span
              className={cn(
                'inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wide',
                BADGE_TONES[note.tone]
              )}
            >
              {note.label}
            </span>
            <p className="text-muted-foreground text-xs leading-relaxed">{note.meaning}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Estimated time                                                             */
/* -------------------------------------------------------------------------- */

function TimingSection({ timing }: { timing: ScopeNodeTiming }) {
  const [open, setOpen] = useState(false);
  const { fullSeconds, lightSeconds, depth } = timing;
  // Both bars are drawn against the full figure, so "light" reads as a fraction of the topic rather
  // than as a bar of its own. A topic that prices at nothing still gets a track, not a divide by zero.
  const lightRatio = fullSeconds > 0 ? Math.min(1, lightSeconds / fullSeconds) : 0;
  const sameRun = lightSeconds === fullSeconds;

  return (
    <section className="bg-card space-y-2 rounded-lg border p-3" data-testid="routing-map-timing">
      <header className="flex items-center justify-between gap-2">
        <h4 className={SECTION_LABEL}>Estimated answering time</h4>
        <FieldHelp title="How this is estimated" contentClassName="w-80">
          <p>
            An estimate built from the questionnaire itself, not from the conversation. Every
            question is charged a rate for its type — a rating is quick, an open question is not — a
            rating grid is charged per row, and a data slot has a rate of its own. This
            version&rsquo;s rates are the ones shown in the breakdown.
          </p>
          <p>
            <strong>It is answering time only.</strong> The interview is a chat: the agent&rsquo;s
            own turns, its follow-ups, re-asks and any back-and-forth are not counted. A real
            conversation runs longer than this figure — often considerably. Read it as relative
            weight, never as a stopwatch.
          </p>
          <p>
            It is still the number that decides things: the planner fits topics to the session
            budget with exactly this arithmetic, so the topic that looks expensive here is the one
            it drops first.
          </p>
        </FieldHelp>
      </header>

      {/* Collapsed, the two readings ARE the section: a figure each, the authored one carrying the
          weight. Expanding swaps them for the fuller cards rather than repeating them underneath,
          so the disclosure reads as a zoom into the same thing and never as a second answer. */}
      {open ? (
        <div className="space-y-2">
          <DepthFigure
            label="Full"
            note={`all ${countLabel(timing.memberCount)}`}
            seconds={fullSeconds}
            ratio={1}
            active={depth === 'full'}
          />
          <DepthFigure
            label="Light"
            note={
              sameRun
                ? 'this topic is small enough that a light run is the whole of it'
                : `the ${countLabel(timing.lightMemberCount)} carrying the most weight`
            }
            seconds={lightSeconds}
            ratio={lightRatio}
            active={depth === 'light'}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <DepthReading label="full" seconds={fullSeconds} active={depth === 'full'} />
          <span className="text-muted-foreground/40 text-xs">·</span>
          <DepthReading label="light" seconds={lightSeconds} active={depth === 'light'} />
        </div>
      )}

      {open ? (
        <div className="space-y-3">
          {timing.groups.length > 0 ? (
            <div className="space-y-1.5 border-t pt-2.5">
              <p className={SECTION_LABEL}>How the full figure adds up</p>
              <dl className="space-y-1">
                {timing.groups.map((group) => (
                  <div
                    key={`${group.label}-${group.secondsEach}`}
                    className="flex items-baseline justify-between gap-3 text-[11px]"
                  >
                    <dt className="text-muted-foreground min-w-0 truncate">
                      {group.count} × {group.label}{' '}
                      <span className="opacity-70">@ {formatSeconds(group.secondsEach)}</span>
                    </dt>
                    <dd className="shrink-0 font-medium tabular-nums">
                      {formatSeconds(group.seconds)}
                    </dd>
                  </div>
                ))}
              </dl>
              {timing.unresolvedCount > 0 ? (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                  <span>
                    {countLabel(timing.unresolvedCount)} no longer{' '}
                    {timing.unresolvedCount === 1 ? 'exists' : 'exist'} in this version, so nothing
                    is charged for {timing.unresolvedCount === 1 ? 'it' : 'them'}.
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}

          {timing.lightItems.length > 0 ? (
            <div className="space-y-1.5 border-t pt-2.5">
              <p className={SECTION_LABEL}>A light run asks only</p>
              <ul className="space-y-1">
                {timing.lightItems.map((item) => (
                  <li key={item.key} className="flex items-baseline gap-2 text-[11px]">
                    <span className="bg-muted-foreground/40 mt-1.5 h-1 w-1 shrink-0 rounded-full" />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2" title={item.label}>
                        {item.label}
                      </span>
                      <span className="text-muted-foreground">
                        {item.typeLabel} · {formatSeconds(item.seconds)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The caveat is never collapsed, only shortened. The figure is answering time and the
          interview is a chat, so a reader who never opens the disclosure must still not read it as
          a stopwatch — that misreading is what sets a budget which halves the instrument. */}
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        {open ? (
          <>
            Answering time only. The agent&rsquo;s own turns and its follow-ups are not counted, so
            the chat runs longer than this.
          </>
        ) : (
          <>Answering time only — a real chat runs longer.</>
        )}
      </p>

      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1 rounded px-1 py-0.5 text-[11px] transition-colors"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        {open ? 'Hide the arithmetic' : 'How this is worked out'}
      </button>
    </section>
  );
}

/** One depth's figure at a glance: the duration, what it is, and whether it is the one that counts. */
function DepthReading({
  label,
  seconds,
  active,
}: {
  label: string;
  seconds: number;
  active: boolean;
}) {
  return (
    <span className="flex items-baseline gap-1">
      <span
        className={cn(
          'text-sm leading-none font-semibold tabular-nums',
          !active && 'text-muted-foreground font-normal'
        )}
      >
        {formatSeconds(seconds)}
      </span>
      <span className="text-muted-foreground text-[11px]">{label}</span>
      {active ? (
        <span className="text-primary border-primary/30 rounded-full border px-1.5 py-px text-[10px] leading-none">
          this topic
        </span>
      ) : null}
    </span>
  );
}

/** One depth's figure: the duration, its share of the topic, and what it covers. */
function DepthFigure({
  label,
  note,
  seconds,
  ratio,
  active,
}: {
  label: string;
  note: string;
  seconds: number;
  ratio: number;
  active: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-2 transition-colors',
        // The authored depth is the figure that actually applies; the other is context. Marking it
        // is the difference between two numbers and one answer.
        active ? 'border-primary/40 bg-primary/[0.06]' : 'border-transparent'
      )}
      data-active={active || undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-1.5 text-xs font-medium">
          {label}
          {active ? (
            <span className="text-primary border-primary/30 rounded-full border px-1.5 py-px text-[10px] leading-none font-normal">
              this topic
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            'text-base leading-none font-semibold tabular-nums',
            !active && 'text-muted-foreground'
          )}
        >
          {formatSeconds(seconds)}
        </span>
      </div>
      <div className="bg-muted mt-2 h-1 overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full', active ? 'bg-primary' : 'bg-muted-foreground/40')}
          style={{ width: `${Math.max(ratio * 100, seconds > 0 ? 2 : 0)}%` }}
        />
      </div>
      <p className="text-muted-foreground mt-1.5 text-[11px] leading-snug">{note}</p>
    </div>
  );
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'member' : 'members'}`;
}

/* -------------------------------------------------------------------------- */
/* Criteria                                                                   */
/* -------------------------------------------------------------------------- */

/** Chip tones. Ordered by how loudly the author asked for the signal to count. */
const PRIORITY_TONES: Record<CriteriaPriority, string> = {
  high: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  medium: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  low: 'border-muted-foreground/30 bg-muted text-muted-foreground',
};

function CriteriaSection({ text }: { text: string }) {
  const blocks = parseCriteria(text);
  if (blocks.length === 0) return null;

  return (
    <section className="space-y-2" data-testid="routing-map-criteria">
      <h4 className={SECTION_LABEL}>Criteria</h4>
      <div className="bg-muted/30 space-y-2.5 rounded-lg border p-3">
        {blocks.map((block, index) =>
          block.kind === 'text' ? (
            <p key={`text-${index}`} className="text-xs leading-relaxed whitespace-pre-wrap">
              {block.text}
            </p>
          ) : (
            <ul key={`list-${index}`} className="space-y-2">
              {block.items.map((item, i) => (
                <CriteriaLine key={`${index}-${i}`} item={item} />
              ))}
            </ul>
          )
        )}
      </div>
    </section>
  );
}

function CriteriaLine({ item }: { item: CriteriaItem }) {
  return (
    <li className="border-muted-foreground/25 border-l-2 pl-2.5">
      {item.term || item.priority ? (
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          {item.term ? <span className="text-xs font-medium">{item.term}</span> : null}
          {item.priority ? (
            <span
              className={cn(
                'rounded-full border px-1.5 py-px text-[10px] leading-none whitespace-nowrap',
                PRIORITY_TONES[item.priority]
              )}
            >
              {item.priority} priority
            </span>
          ) : null}
        </div>
      ) : null}
      <p
        className={cn(
          'text-xs leading-relaxed whitespace-pre-wrap',
          item.term || item.priority ? 'text-muted-foreground mt-0.5' : ''
        )}
      >
        {item.body}
      </p>
    </li>
  );
}
