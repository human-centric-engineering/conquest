'use client';

/**
 * The topic set editor — the authoring surface for Adaptive Scope's conditional unit.
 *
 * The whole set is edited locally and saved with one PUT (`replaceTopics` deletes and rewrites),
 * matching `data-slots-review.tsx`. A per-row PATCH surface would buy nothing here: ordinals come
 * from list order, and "delete this one" has no natural expression in a row-wise merge.
 *
 * Two things about this editor carry weight beyond the pixels:
 *
 * - **Size is not significant.** A topic may hold thirty questions or one, and a one-question topic
 *   is how a fine-grained interdependency is expressed ("only ask about channel conflict if they
 *   sell through partners"). That is why there is no second `showIf` expression language to learn —
 *   the coarse and fine cases are the same mechanism at different sizes.
 * - **Membership is keys.** The picker writes question/data-slot KEYS, never row ids, which is what
 *   lets a topic survive a version fork with no re-linking at all.
 */

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

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

const SOURCE_BADGE: Record<DraftTopic['source'], { label: string; hint: string }> = {
  seeded: { label: 'Auto-seeded', hint: 'Created from a section when the document was ingested.' },
  manual: { label: 'Authored', hint: 'Reviewed or written by an admin.' },
  analyst: { label: 'From the analyst', hint: 'Proposed by the Routing Analyst and accepted.' },
  new: { label: 'New', hint: 'Not saved yet.' },
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
}

export function TopicListEditor({
  topics,
  inventory,
  onSave,
  busy,
  enabled,
}: TopicListEditorProps) {
  const [drafts, setDrafts] = useState<DraftTopic[]>(() => topics.map(toDraft));
  const [dirty, setDirty] = useState(false);

  const questionOptions: KeyOption[] = useMemo(
    () => inventory.questions.map((q) => ({ key: q.key, text: q.prompt, group: q.sectionTitle })),
    [inventory.questions]
  );
  const dataSlotOptions: KeyOption[] = useMemo(
    () => inventory.dataSlots.map((d) => ({ key: d.key, text: d.name, group: d.theme })),
    [inventory.dataSlots]
  );

  // Which questions no topic claims. With scope active such a question can never be asked, and
  // nothing else in the system reports it — so the count is surfaced live, as the admin edits,
  // rather than only in the saved-set findings above.
  const uncovered = useMemo(() => {
    const covered = new Set(drafts.flatMap((d) => d.questionKeys));
    return inventory.questions.filter((q) => !covered.has(q.key));
  }, [drafts, inventory.questions]);

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
    setDirty(true);
    setDrafts((prev) => {
      const taken = new Set(prev.map((d) => d.key));
      return [
        ...prev,
        {
          clientId: `new-${prev.length}-${taken.size}`,
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
      ];
    });
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

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const d of drafts) {
      if (seen.has(d.key)) dupes.add(d.key);
      seen.add(d.key);
    }
    return dupes;
  }, [drafts]);

  const save = async () => {
    const ok = await onSave(drafts);
    if (ok) setDirty(false);
    return ok;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {drafts.length} {drafts.length === 1 ? 'topic' : 'topics'} ·{' '}
          {drafts.filter((d) => d.phase === 'conditional').length} conditional
          {uncovered.length > 0 && (
            <>
              {' · '}
              <span className={enabled ? 'text-destructive' : 'text-amber-600'}>
                {uncovered.length} question{uncovered.length === 1 ? '' : 's'} in no topic
              </span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={add} disabled={busy}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Add topic
          </Button>
          <SaveButton onSave={save} disabled={busy || !dirty} size="sm">
            Save topics
          </SaveButton>
        </div>
      </div>

      {duplicateKeys.size > 0 && (
        <p className="text-destructive text-xs" role="alert">
          Two topics share the key {[...duplicateKeys].join(', ')}. Keys address a topic from rules
          and plans, so they must be unique — the save will be rejected until you fix it.
        </p>
      )}

      {drafts.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">
          No topics yet. Uploading a document seeds one per section; “Add topic” starts from
          nothing.
        </p>
      ) : (
        <ul className="space-y-3">
          {drafts.map((draft, index) => {
            const badge = SOURCE_BADGE[draft.source];
            return (
              <li key={draft.clientId}>
                <Card className="overflow-hidden">
                  <CardContent className="space-y-4 p-4">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <Label className="text-sm font-medium">Name</Label>
                        <Input
                          value={draft.label}
                          onChange={(e) => renameFromLabel(index, e.target.value)}
                          placeholder="Pipeline management"
                          disabled={busy}
                        />
                      </div>
                      <div className="w-56 space-y-1.5">
                        <Label className="text-sm font-medium">
                          Key{' '}
                          <FieldHelp title="Topic key">
                            The stable slug rules, plans and the blind-spot preference use to
                            address this topic. Lowercase letters, numbers and underscores. Changing
                            it on a topic that rules already name will silently stop those rules
                            matching — the findings above will say so.
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
                      <div className="flex shrink-0 flex-col items-end gap-1 pt-6">
                        <Badge variant="outline" title={badge.hint} className="text-[10px]">
                          {badge.label}
                        </Badge>
                        <div className="flex items-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={`Move ${draft.label || draft.key} up`}
                            onClick={() => move(index, -1)}
                            disabled={busy || index === 0}
                          >
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            aria-label={`Move ${draft.label || draft.key} down`}
                            onClick={() => move(index, 1)}
                            disabled={busy || index === drafts.length - 1}
                          >
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive h-7 w-7"
                            aria-label={`Remove ${draft.label || draft.key}`}
                            onClick={() => remove(index)}
                            disabled={busy}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label className="text-sm font-medium">
                          When it runs{' '}
                          <FieldHelp title="Phase">
                            Only <strong>conditional</strong> topics are ever chosen between.
                            Opening runs first and its answers are what the agent reads when
                            deciding; core and closing always run.
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
                            sample, not a score. The blind-spot check forces light regardless of
                            what you set here, because in that interview its job is to sample.
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
                          Your own words about when this topic applies, judged against what the
                          respondent actually said in the opening. Write the condition, not the
                          instruction: “they sell through partners or resellers” reads better to the
                          agent than “ask this if relevant”.
                        </FieldHelp>
                      </Label>
                      <AutoTextarea
                        value={draft.criteria}
                        onChange={(e) => mutate(index, { criteria: e.target.value })}
                        placeholder="They named growth as a priority and have a sales team of more than five."
                        disabled={busy}
                        rows={2}
                      />
                      {draft.phase !== 'conditional' ? (
                        <p className="text-muted-foreground text-xs">
                          Kept, but not used — {TOPIC_PHASE_LABELS[draft.phase].toLowerCase()}{' '}
                          topics are never chosen between.
                        </p>
                      ) : (
                        draft.criteria.trim().length === 0 && (
                          <p
                            className={cn(
                              'text-xs',
                              enabled ? 'text-destructive' : 'text-amber-600'
                            )}
                          >
                            A conditional topic with no criteria gives the agent nothing to judge it
                            on.
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
                      />
                      <KeyPicker
                        label="Data slots"
                        options={dataSlotOptions}
                        selected={draft.dataSlotKeys}
                        onChange={(next) => mutate(index, { dataSlotKeys: next })}
                        disabled={busy}
                        emptyText="This version has no data slots yet."
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
