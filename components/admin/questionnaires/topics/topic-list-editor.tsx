'use client';

/**
 * The topic set editor — the authoring surface for Adaptive Scope's conditional unit.
 *
 * The whole set is edited locally and saved with one PUT (`replaceTopics` deletes and rewrites),
 * matching `data-slots-review.tsx`. A per-row PATCH surface would buy nothing here: ordinals come
 * from list order, and "delete this one" has no natural expression in a row-wise merge.
 *
 * ## Why the rows collapse
 *
 * Ingesting a document seeds ONE TOPIC PER SECTION, so the common first sight of this page is
 * fifteen-plus topics. Rendered as fifteen open forms it is a page you scroll rather than read, and
 * the two questions an admin actually arrives with — *which of these are conditional* and *which
 * one is misconfigured* — are the two the open forms answer worst. So a row collapses to the line
 * that answers both, and opens to the full editor when it is the one being worked on. Rows needing
 * attention (a conditional topic with no criteria, a duplicate key, a member that no longer exists)
 * are marked in the collapsed line, so nothing hides behind a chevron.
 *
 * Reordering is disabled while a filter is applied: "move up" means "swap with the row above", and
 * with rows hidden the row above on screen is not the row above in the set.
 *
 * Two things about this editor carry weight beyond the pixels:
 *
 * - **Size is not significant.** A topic may hold thirty questions or one, and a one-question topic
 *   is how a fine-grained interdependency is expressed ("only ask about site access if they work
 *   on client premises"). That is why there is no second `showIf` expression language to learn —
 *   the coarse and fine cases are the same mechanism at different sizes.
 * - **Membership is keys.** The picker writes question/data-slot KEYS, never row ids, which is what
 *   lets a topic survive a version fork with no re-linking at all.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Plus,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SaveButton } from '@/components/admin/questionnaires/save-button';
import { KeyPicker, type KeyOption } from '@/components/admin/questionnaires/topics/key-picker';
import { nextAvailableKey, slugifyKey } from '@/lib/app/questionnaire/authoring/key';
import {
  TOPIC_DEPTHS,
  TOPIC_DEPTH_LABELS,
  TOPIC_PHASES,
  TOPIC_PHASE_DESCRIPTIONS,
  TOPIC_PHASE_LABELS,
  type Topic,
  type TopicDepth,
  type TopicPhase,
} from '@/lib/app/questionnaire/scope/types';
import { formatSeconds } from '@/lib/app/questionnaire/scope/budget';
import { membersAtDepth } from '@/lib/app/questionnaire/scope/resolve';
import type { TopicsPayload } from '@/lib/app/questionnaire/scope/views';
import { cn } from '@/lib/utils';

/** One topic in the working set. `clientId` is a React key only — never persisted. */
interface DraftTopic {
  clientId: string;
  key: string;
  label: string;
  description: string;
  phase: TopicPhase;
  criteria: string;
  depth: TopicDepth;
  questionKeys: string[];
  dataSlotKeys: string[];
  /** Where the topic came from, so an untouched auto-seed reads as one. */
  source: Topic['source'] | 'new';
}

/**
 * What a draft topic costs a respondent, in seconds (C7).
 *
 * Computed here rather than read off `costs.byTopicKey` on purpose: the server's per-topic figures
 * describe the SAVED set, and this row is showing an unsaved draft. Add three questions to a topic
 * and a server-sourced number would sit there unchanged, which is worse than showing none.
 *
 * It selects members through `membersAtDepth` — the same resolver the interview uses — so a `light`
 * topic is costed as the sample it will actually ask. No weights are passed, which is exactly the
 * resolver's own no-weights fallback (authored order); the server, which has them, may pick two
 * different members for a light topic and land a few seconds apart. Both are estimates, and the
 * alternative is duplicating the weighting rule in the browser.
 */
function draftSeconds(draft: DraftTopic, itemCost: ReadonlyMap<string, number>): number {
  const keys = [
    ...membersAtDepth(draft.questionKeys, draft.depth, undefined),
    ...membersAtDepth(draft.dataSlotKeys, draft.depth, undefined),
  ];
  let total = 0;
  for (const key of keys) total += itemCost.get(key) ?? 0;
  return total;
}

const SOURCE_BADGE: Record<DraftTopic['source'], { label: string; hint: string }> = {
  seeded: { label: 'Auto-seeded', hint: 'Created from a section when the document was ingested.' },
  manual: { label: 'Authored', hint: 'Reviewed or written by an admin.' },
  analyst: { label: 'From the analyst', hint: 'Proposed by the Routing Analyst and accepted.' },
  new: { label: 'New', hint: 'Not saved yet.' },
};

/** Short phase label for the collapsed row — the full ones carry a trailing explanation. */
const PHASE_CHIP: Record<TopicPhase, string> = {
  opening: 'Opening',
  core: 'Always ask',
  conditional: 'Ask when it fits',
  closing: 'Closing',
};

/** Which rows a filter chip keeps. `attention` is computed per row, not a phase. */
type TopicFilter = 'all' | 'conditional' | 'always' | 'attention';

const FILTER_LABELS: Record<TopicFilter, string> = {
  all: 'All',
  conditional: 'Conditional',
  always: 'Always asked',
  attention: 'Needs attention',
};

function toDraft(topic: Topic, index: number): DraftTopic {
  return {
    clientId: `t-${index}-${topic.key}`,
    key: topic.key,
    label: topic.label,
    description: topic.description ?? '',
    phase: topic.phase,
    criteria: topic.criteria ?? '',
    depth: topic.depth,
    questionKeys: [...topic.members.questionKeys],
    dataSlotKeys: [...topic.members.dataSlotKeys],
    source: topic.source,
  };
}

export interface TopicListEditorProps {
  topics: readonly Topic[];
  inventory: TopicsPayload['inventory'];
  /** Saves the reviewed set. Resolving `false` means the save did not land (error or cancel). */
  onSave: (topics: DraftTopic[]) => Promise<boolean>;
  busy: boolean;
  /** True when the feature is on — drives the "criteria is what the agent judges" emphasis. */
  enabled: boolean;
  /**
   * A topic another surface has asked to edit — today, the routing map's "Edit this topic".
   *
   * Carries a `nonce` rather than being a bare key because asking for the SAME topic twice must still
   * move the list: with a plain string the second request is unchanged state and the effect below
   * never re-fires, so the second click would do nothing at all.
   */
  focusTopic?: { key: string; nonce: number } | null;
}

export function TopicListEditor({
  topics,
  inventory,
  onSave,
  busy,
  enabled,
  focusTopic,
}: TopicListEditorProps) {
  // Per-item seconds, keyed once. The route priced every question and data slot against this
  // version's own overrides, so the browser never re-derives a per-type estimate.
  const itemCost = useMemo(
    () =>
      new Map<string, number>([
        ...inventory.questions.map((q) => [q.key, q.estimatedSeconds] as const),
        ...inventory.dataSlots.map((d) => [d.key, d.estimatedSeconds] as const),
      ]),
    [inventory]
  );

  const [drafts, setDrafts] = useState<DraftTopic[]>(() => topics.map(toDraft));
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState<TopicFilter>('all');
  const [showUncovered, setShowUncovered] = useState(false);
  // Collapsed by default: a seeded set is long, and the collapsed line answers the two questions an
  // admin arrives with. A topic opens when they choose it, or when they have just added it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  const questionOptions: KeyOption[] = useMemo(
    () => inventory.questions.map((q) => ({ key: q.key, text: q.prompt, group: q.sectionTitle })),
    [inventory.questions]
  );
  const dataSlotOptions: KeyOption[] = useMemo(
    () => inventory.dataSlots.map((d) => ({ key: d.key, text: d.name, group: d.theme })),
    [inventory.dataSlots]
  );

  const questionKeySet = useMemo(
    () => new Set(inventory.questions.map((q) => q.key)),
    [inventory.questions]
  );
  const dataSlotKeySet = useMemo(
    () => new Set(inventory.dataSlots.map((d) => d.key)),
    [inventory.dataSlots]
  );

  // Which questions no topic claims. With scope active such a question can never be asked, and
  // nothing else in the system reports it — so the count is surfaced live, as the admin edits,
  // rather than only in the saved-set findings above.
  const uncovered = useMemo(() => {
    const covered = new Set(drafts.flatMap((d) => d.questionKeys));
    return inventory.questions.filter((q) => !covered.has(q.key));
  }, [drafts, inventory.questions]);

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const d of drafts) {
      if (seen.has(d.key)) dupes.add(d.key);
      seen.add(d.key);
    }
    return dupes;
  }, [drafts]);

  /**
   * Everything wrong with one row, in the words the collapsed line shows. Kept here rather than in
   * the open editor so a problem is visible without expanding — the whole point of collapsing.
   */
  const problemsFor = (draft: DraftTopic): string[] => {
    const found: string[] = [];
    if (draft.label.trim().length === 0) found.push('No name');
    if (duplicateKeys.has(draft.key)) found.push('Duplicate key');
    if (draft.phase === 'conditional' && draft.criteria.trim().length === 0) {
      found.push('No criteria');
    }
    if (draft.questionKeys.length === 0 && draft.dataSlotKeys.length === 0) {
      found.push('Nothing in it');
    }
    const missing =
      draft.questionKeys.filter((k) => !questionKeySet.has(k)).length +
      draft.dataSlotKeys.filter((k) => !dataSlotKeySet.has(k)).length;
    if (missing > 0) found.push(`${missing} missing ${missing === 1 ? 'member' : 'members'}`);
    return found;
  };

  const conditionalCount = drafts.filter((d) => d.phase === 'conditional').length;
  const attentionCount = drafts.filter((d) => problemsFor(d).length > 0).length;

  const visible = drafts
    .map((draft, index) => ({ draft, index }))
    .filter(({ draft }) => {
      if (filter === 'conditional') return draft.phase === 'conditional';
      if (filter === 'always') return draft.phase !== 'conditional';
      if (filter === 'attention') return problemsFor(draft).length > 0;
      return true;
    });

  const filtering = filter !== 'all';

  // One DOM node per rendered row, so the focus effect can scroll to a topic without reaching into
  // the document. Rows unmount as the filter changes, so entries are cleaned up on unmount.
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const registerRow = (clientId: string) => (el: HTMLLIElement | null) => {
    if (el) rowRefs.current.set(clientId, el);
    else rowRefs.current.delete(clientId);
  };

  // "Edit this topic", arriving from the routing map.
  //
  // The filter is cleared first, and that is the whole reason this is an effect rather than a call:
  // a topic hidden by the current filter has no row to expand, so setting `expanded` alone would look
  // to the admin like the button did nothing. Clearing is safe — the filter is a view preference, and
  // the alternative (silently failing to honour an explicit request) is worse.
  useEffect(() => {
    if (!focusTopic) return;
    const target = drafts.find((d) => d.key === focusTopic.key);
    if (!target) return;
    setFilter('all');
    setExpanded((prev) => new Set(prev).add(target.clientId));
    // One frame later: the row may have only just been revealed by the filter reset above, so it does
    // not exist yet at the moment this effect runs.
    const raf = requestAnimationFrame(() => {
      rowRefs.current
        .get(target.clientId)
        ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
    // `drafts` is deliberately not a dependency: this must fire when a request ARRIVES, not every
    // time the admin types a character into a topic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTopic]);

  const setOpen = (clientId: string, open: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(clientId);
      else next.delete(clientId);
      return next;
    });
  };

  const mutate = (index: number, patch: Partial<DraftTopic>) => {
    setDirty(true);
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    setDirty(true);
    setDrafts((prev) => {
      const next = [...prev];
      const [row] = next.splice(index, 1);
      if (row) next.splice(target, 0, row);
      return next;
    });
  };

  const remove = (index: number) => {
    setDirty(true);
    setDrafts((prev) => prev.filter((_, i) => i !== index));
  };

  const add = () => {
    const taken = new Set(drafts.map((d) => d.key));
    const clientId = `new-${drafts.length}-${taken.size}`;
    setDirty(true);
    setFilter('all');
    // A topic you just created is the one you are about to fill in — open it.
    setOpen(clientId, true);
    setDrafts((prev) => [
      ...prev,
      {
        clientId,
        key: nextAvailableKey('new_topic', taken),
        label: '',
        description: '',
        phase: 'conditional',
        criteria: '',
        depth: 'full',
        questionKeys: [],
        dataSlotKeys: [],
        source: 'new',
      },
    ]);
  };

  /** Derive the key from the name, but only while the admin has not hand-set one. */
  const renameFromLabel = (index: number, label: string) => {
    const current = drafts[index];
    if (!current) return;
    const autoKey = current.source === 'new' && current.key.startsWith('new_topic');
    if (!autoKey) {
      mutate(index, { label });
      return;
    }
    const taken = new Set(drafts.filter((_, i) => i !== index).map((d) => d.key));
    const derived = label.trim().length > 0 ? nextAvailableKey(slugifyKey(label), taken) : '';
    mutate(index, { label, ...(derived.length > 0 ? { key: derived } : {}) });
  };

  const save = async () => {
    const ok = await onSave(drafts);
    if (ok) setDirty(false);
    return ok;
  };

  const allVisibleOpen =
    visible.length > 0 && visible.every(({ draft }) => expanded.has(draft.clientId));

  const toggleAll = () => {
    setExpanded(allVisibleOpen ? new Set<string>() : new Set(visible.map((v) => v.draft.clientId)));
  };

  return (
    <div className="space-y-3">
      {/* Counts and actions. The counts are the page's answer to "what have I got?" and stay put
          while the list below is filtered — a filtered count would hide the set's real shape. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          <span className="text-foreground font-medium">
            {drafts.length} {drafts.length === 1 ? 'topic' : 'topics'}
          </span>{' '}
          · {conditionalCount} conditional
          {uncovered.length > 0 && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => setShowUncovered((v) => !v)}
                aria-expanded={showUncovered}
                className={cn(
                  'underline decoration-dotted underline-offset-2',
                  enabled ? 'text-destructive' : 'text-amber-600'
                )}
              >
                {uncovered.length} question{uncovered.length === 1 ? '' : 's'} in no topic
              </button>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          {drafts.length > 1 && (
            <Button variant="ghost" size="sm" onClick={toggleAll} disabled={busy}>
              {allVisibleOpen ? (
                <>
                  <ChevronsDownUp className="mr-1 h-4 w-4" aria-hidden="true" /> Collapse all
                </>
              ) : (
                <>
                  <ChevronsUpDown className="mr-1 h-4 w-4" aria-hidden="true" /> Expand all
                </>
              )}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={add} disabled={busy}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Add topic
          </Button>
          <SaveButton onSave={save} disabled={busy || !dirty} size="sm">
            Save topics
          </SaveButton>
        </div>
      </div>

      {/* Naming the uncovered questions, not just counting them: the fix is to put each one in a
          topic, and an admin cannot do that from a number. */}
      {showUncovered && uncovered.length > 0 && (
        <div className="bg-muted/30 space-y-2 rounded-md border p-3">
          <p className="text-xs font-medium">
            These questions belong to no topic
            <FieldHelp title="Questions in no topic" className="ml-1">
              Scope filters the question bank down to the topics in play, so a question no topic
              claims is filtered out of every interview — it can never be asked, and no other
              surface reports it. Add each one to a topic, or delete it on the Structure tab if it
              is no longer wanted.
            </FieldHelp>
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {uncovered.map((q) => (
              <li key={q.key} className="flex items-baseline gap-2 text-xs">
                <code className="text-muted-foreground shrink-0">{q.key}</code>
                <span className="min-w-0 flex-1 truncate">{q.prompt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {duplicateKeys.size > 0 && (
        <p className="text-destructive text-xs" role="alert">
          Two topics share the key {[...duplicateKeys].join(', ')}. Keys address a topic from rules
          and plans, so they must be unique — the save will be rejected until you fix it.
        </p>
      )}

      {/* Filters. Only worth the row once the set is big enough to need skimming. */}
      {drafts.length > 3 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Filter topics"
        >
          {(['all', 'conditional', 'always', 'attention'] as const).map((option) => {
            const count =
              option === 'all'
                ? drafts.length
                : option === 'conditional'
                  ? conditionalCount
                  : option === 'always'
                    ? drafts.length - conditionalCount
                    : attentionCount;
            const active = filter === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                aria-pressed={active}
                disabled={option === 'attention' && count === 0}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition-colors',
                  active
                    ? 'bg-foreground text-background border-transparent'
                    : 'hover:bg-muted disabled:opacity-40',
                  !active &&
                    option === 'attention' &&
                    count > 0 &&
                    'border-amber-400 text-amber-700 dark:text-amber-400'
                )}
              >
                {FILTER_LABELS[option]} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {drafts.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">
          No topics yet. Uploading a document seeds one per section; “Add topic” starts from
          nothing.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">
          No topics match this filter.{' '}
          <button type="button" className="underline" onClick={() => setFilter('all')}>
            Show all {drafts.length}
          </button>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map(({ draft, index }) => {
            const badge = SOURCE_BADGE[draft.source];
            const problems = problemsFor(draft);
            const open = expanded.has(draft.clientId);
            const name = draft.label.trim().length > 0 ? draft.label : 'Untitled topic';
            return (
              <li key={draft.clientId} ref={registerRow(draft.clientId)}>
                <Card
                  className={cn(
                    'overflow-hidden transition-shadow',
                    open && 'shadow-sm',
                    problems.length > 0 && 'border-amber-400/60'
                  )}
                >
                  {/* The collapsed line: name, when it runs, how big it is, and what is wrong. */}
                  <div className="flex items-start gap-2 p-3">
                    <button
                      type="button"
                      onClick={() => setOpen(draft.clientId, !open)}
                      aria-expanded={open}
                      className="hover:bg-muted/50 focus-visible:ring-ring -m-1 flex min-w-0 flex-1 items-start gap-2 rounded p-1 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
                    >
                      <ChevronDown
                        className={cn(
                          'text-muted-foreground mt-0.5 h-4 w-4 shrink-0 transition-transform duration-200',
                          open && 'rotate-180'
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span
                            className={cn(
                              'text-sm font-medium',
                              draft.label.trim().length === 0 && 'text-muted-foreground italic'
                            )}
                          >
                            {name}
                          </span>
                          <Badge
                            variant={draft.phase === 'conditional' ? 'default' : 'secondary'}
                            className="text-[10px] font-normal"
                          >
                            {PHASE_CHIP[draft.phase]}
                          </Badge>
                          {draft.depth === 'light' && (
                            <Badge variant="outline" className="text-[10px] font-normal">
                              Light
                            </Badge>
                          )}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {draft.questionKeys.length}{' '}
                          {draft.questionKeys.length === 1 ? 'question' : 'questions'} ·{' '}
                          {draft.dataSlotKeys.length}{' '}
                          {draft.dataSlotKeys.length === 1 ? 'data slot' : 'data slots'}
                          {' · ~'}
                          {formatSeconds(draftSeconds(draft, itemCost))}
                          {draft.phase === 'conditional' && draft.criteria.trim().length > 0 && (
                            <> · when {draft.criteria.trim()}</>
                          )}
                        </span>
                        {problems.length > 0 && (
                          <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                            <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                            {problems.join(' · ')}
                          </span>
                        )}
                      </span>
                    </button>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge variant="outline" title={badge.hint} className="text-[10px]">
                        {badge.label}
                      </Badge>
                      <div className="flex items-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Move ${name} up`}
                          title={
                            filtering
                              ? 'Clear the filter to reorder — “up” means the row above in the full set'
                              : 'Move up'
                          }
                          onClick={() => move(index, -1)}
                          disabled={busy || filtering || index === 0}
                        >
                          <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={`Move ${name} down`}
                          title={
                            filtering
                              ? 'Clear the filter to reorder — “down” means the row below in the full set'
                              : 'Move down'
                          }
                          onClick={() => move(index, 1)}
                          disabled={busy || filtering || index === drafts.length - 1}
                        >
                          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive h-7 w-7"
                          aria-label={`Remove ${name}`}
                          onClick={() => remove(index)}
                          disabled={busy}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  {open && (
                    <CardContent className="space-y-4 border-t p-4">
                      <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            Name{' '}
                            <FieldHelp title="Topic name">
                              What this group of questions is about, in the words you would use to
                              describe it. The agent reads it alongside your criteria when deciding,
                              and the respondent may hear it in the interviewer&rsquo;s announcement
                              — so name the subject, not the rule (“Site access”, not “Optional
                              section 4”).
                            </FieldHelp>
                          </Label>
                          <Input
                            value={draft.label}
                            onChange={(e) => renameFromLabel(index, e.target.value)}
                            placeholder="Site access"
                            disabled={busy}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            Key{' '}
                            <FieldHelp title="Topic key">
                              The stable slug rules, plans and the blind-spot preference use to
                              address this topic. Lowercase letters, numbers and underscores. It is
                              filled in from the name and you rarely need to touch it. Changing it
                              on a topic that rules already name will silently stop those rules
                              matching — the findings at the top of the page will say so.
                            </FieldHelp>
                          </Label>
                          <Input
                            value={draft.key}
                            onChange={(e) => mutate(index, { key: e.target.value })}
                            className={cn(
                              'font-mono text-xs',
                              duplicateKeys.has(draft.key) && 'border-destructive'
                            )}
                            disabled={busy}
                          />
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            When it runs{' '}
                            <FieldHelp title="Phase">
                              <p>
                                Only <strong>conditional</strong> topics are ever chosen between —
                                everything else on this page exists to decide those.
                              </p>
                              <p className="mt-2">
                                <strong>Opening</strong> runs first, and its answers are what the
                                agent reads when deciding. <strong>Always ask</strong> and{' '}
                                <strong>Closing</strong> run for everyone, whatever they say.
                              </p>
                            </FieldHelp>
                          </Label>
                          <Select
                            value={draft.phase}
                            onValueChange={(v) => mutate(index, { phase: v as TopicPhase })}
                            disabled={busy}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TOPIC_PHASES.map((phase) => (
                                <SelectItem key={phase} value={phase}>
                                  {TOPIC_PHASE_LABELS[phase]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-muted-foreground text-xs">
                            {TOPIC_PHASE_DESCRIPTIONS[draft.phase]}
                          </p>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-sm font-medium">
                            How much of it{' '}
                            <FieldHelp title="Depth">
                              <strong>Light</strong> includes only the highest-weight members — a
                              sample, not a score, and every report that mentions the topic says so.
                              The blind-spot check forces light regardless of what you set here,
                              because in that interview its job is to sample.
                            </FieldHelp>
                          </Label>
                          <Select
                            value={draft.depth}
                            onValueChange={(v) => mutate(index, { depth: v as TopicDepth })}
                            disabled={busy}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TOPIC_DEPTHS.map((depth) => (
                                <SelectItem key={depth} value={depth}>
                                  {TOPIC_DEPTH_LABELS[depth]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-sm font-medium">
                          Include this when…{' '}
                          <FieldHelp title="Criteria">
                            <p>
                              Your own words about when this topic applies, judged against what the
                              respondent actually said in the opening.
                            </p>
                            <p className="mt-2">
                              <strong>Write the condition, not the instruction.</strong> “They work
                              on client premises” reads better to the agent than “ask this if
                              relevant”. Name what would have to be true, and the agent decides
                              whether it is.
                            </p>
                            <p className="mt-2">
                              If you are certain rather than judging — a fact the opening captures
                              in a data slot — write a hard rule above instead, and it is applied
                              before the agent gets a say.
                            </p>
                          </FieldHelp>
                        </Label>
                        <AutoTextarea
                          value={draft.criteria}
                          onChange={(e) => mutate(index, { criteria: e.target.value })}
                          placeholder="They told us they operate across more than one region."
                          disabled={busy}
                          rows={2}
                        />
                        {draft.phase !== 'conditional' ? (
                          <p className="text-muted-foreground text-xs">
                            Kept, but not used — {PHASE_CHIP[draft.phase].toLowerCase()} topics are
                            never chosen between.
                          </p>
                        ) : (
                          draft.criteria.trim().length === 0 && (
                            <p
                              className={cn(
                                'text-xs',
                                enabled ? 'text-destructive' : 'text-amber-600'
                              )}
                            >
                              A conditional topic with no criteria gives the agent nothing to judge
                              it on.
                            </p>
                          )
                        )}
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <KeyPicker
                          label="Questions"
                          options={questionOptions}
                          selected={draft.questionKeys}
                          onChange={(next) => mutate(index, { questionKeys: next })}
                          disabled={busy}
                          emptyText="This version has no questions yet."
                          help={
                            <>
                              <p>
                                The questions this topic covers. When the topic is out of scope,
                                these are not asked and the report records them as{' '}
                                <em>not asked</em> rather than unanswered.
                              </p>
                              <p className="mt-2">
                                Each question should sit in exactly one topic. A question in none
                                can never be asked once adaptive scope is on.
                              </p>
                            </>
                          }
                        />
                        <KeyPicker
                          label="Data slots"
                          options={dataSlotOptions}
                          selected={draft.dataSlotKeys}
                          onChange={(next) => mutate(index, { dataSlotKeys: next })}
                          disabled={busy}
                          emptyText="This version has no data slots yet."
                          help={
                            <>
                              <p>
                                The data slots this topic is responsible for filling. Add them when
                                the conversation is driven by slots rather than by literal
                                questions; otherwise the questions alone are enough.
                              </p>
                              <p className="mt-2">
                                Slots an <em>opening</em> topic fills are what your hard rules read.
                              </p>
                            </>
                          }
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs">
                          Note to yourself{' '}
                          <FieldHelp title="Internal note">
                            Never shown to the respondent and never sent to the agent — this is for
                            whoever edits the questionnaire next.
                          </FieldHelp>
                        </Label>
                        <AutoTextarea
                          value={draft.description}
                          onChange={(e) => mutate(index, { description: e.target.value })}
                          placeholder="Optional"
                          disabled={busy}
                          rows={1}
                        />
                      </div>
                    </CardContent>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export type { DraftTopic };
