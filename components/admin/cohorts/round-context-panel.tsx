'use client';

/**
 * Round Additional Context ("interviewer briefing") manager.
 *
 * Owns the round's `contextEnabled` toggle plus CRUD over briefing entries, grouped by the bundled
 * questionnaire (version) they belong to. Three author paths: a manual add/edit form, document
 * upload → text extraction (fills the content field), and AI-suggested proposals the admin reviews
 * and accepts one at a time. Every mutation hits the API then `router.refresh()` so the SSR list +
 * headline re-read. Styling leans on the shared cohort accent tokens — consistent with the rest of
 * the round detail page, not flashy.
 */

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookText, Loader2, Pencil, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { CohortEmptyState } from '@/components/admin/cohorts/cohort-ui';
import type {
  BriefableQuestionnaire,
  RoundContextEntryView,
  RoundContextSource,
} from '@/lib/app/questionnaire/rounds';

/** Sentinel for the "General (whole questionnaire)" attribution option. */
const GENERAL = '__general__';

const SOURCE_BADGE: Record<RoundContextSource, { label: string; className: string }> = {
  manual: { label: 'Manual', className: 'bg-muted text-muted-foreground' },
  upload: { label: 'Upload', className: 'bg-muted text-muted-foreground' },
  ai_suggested: {
    label: 'AI',
    className: 'bg-[color:var(--cq-accent-muted)] text-[color:var(--cq-accent)]',
  },
};

function SourceBadge({ source }: { source: RoundContextSource }) {
  const s = SOURCE_BADGE[source];
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[0.65rem] font-medium', s.className)}>
      {s.label}
    </span>
  );
}

export interface RoundContextPanelProps {
  roundId: string;
  contextEnabled: boolean;
  entries: RoundContextEntryView[];
  briefable: BriefableQuestionnaire[];
}

export function RoundContextPanel({
  roundId,
  contextEnabled,
  entries,
  briefable,
}: RoundContextPanelProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(contextEnabled);
  const [togglePending, setTogglePending] = useState(false);
  const [panel, setPanel] = useState<'none' | 'add' | 'suggest'>('none');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // version id → questionnaire title, for grouping the list + labelling forms.
  const titleByVersion = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of briefable) map.set(b.versionId, b.title);
    return map;
  }, [briefable]);

  // Entries grouped by their version, in briefable order (orphans — versions no longer bundled —
  // fall into a trailing "Other" bucket so they stay visible + deletable).
  const grouped = useMemo(() => {
    const byVersion = new Map<string, RoundContextEntryView[]>();
    for (const e of entries) {
      const list = byVersion.get(e.versionId) ?? [];
      list.push(e);
      byVersion.set(e.versionId, list);
    }
    const order: string[] = [
      ...briefable.map((b) => b.versionId).filter((v) => byVersion.has(v)),
      ...[...byVersion.keys()].filter((v) => !titleByVersion.has(v)),
    ];
    return order.map((versionId) => ({
      versionId,
      title: titleByVersion.get(versionId) ?? 'Unbundled questionnaire',
      items: byVersion.get(versionId) ?? [],
    }));
  }, [entries, briefable, titleByVersion]);

  const toggle = async (next: boolean) => {
    setTogglePending(true);
    setError(null);
    setEnabled(next); // optimistic
    try {
      await apiClient.patch(API.APP.ROUNDS.byId(roundId), { body: { contextEnabled: next } });
      router.refresh();
    } catch (err) {
      setEnabled(!next); // revert
      setError(err instanceof APIClientError ? err.message : 'Could not update the setting.');
    } finally {
      setTogglePending(false);
    }
  };

  const deleteEntry = async (entryId: string) => {
    setPendingDeleteId(entryId);
    setError(null);
    try {
      await apiClient.delete(API.APP.ROUNDS.contextEntry(roundId, entryId));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not delete the entry.');
    } finally {
      setPendingDeleteId(null);
    }
  };

  const noQuestionnaires = briefable.length === 0;

  return (
    <div className="space-y-4">
      {/* Toggle row */}
      <div className="flex items-start justify-between gap-4 rounded-lg border bg-[color:var(--cq-accent-muted)]/30 px-4 py-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            Use additional context
            <FieldHelp title="Additional context (interviewer briefing)">
              When on, the briefing notes below are quietly given to the interviewer as it asks each
              question — facts and background it can draw on, never read aloud. Off by default;
              nothing is injected until you switch it on.
            </FieldHelp>
          </div>
          <p className="text-muted-foreground text-xs">
            Brief the interviewer with facts &amp; background for this round.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {togglePending && <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />}
          <Switch
            checked={enabled}
            onCheckedChange={(v) => void toggle(v)}
            disabled={togglePending}
            aria-label="Use additional context for this round"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={panel === 'add' ? 'secondary' : 'outline'}
          onClick={() => {
            setEditingId(null);
            setPanel(panel === 'add' ? 'none' : 'add');
          }}
          disabled={noQuestionnaires}
        >
          <Plus className="mr-2 h-4 w-4" /> Add briefing note
        </Button>
        <Button
          size="sm"
          variant={panel === 'suggest' ? 'secondary' : 'outline'}
          onClick={() => setPanel(panel === 'suggest' ? 'none' : 'suggest')}
          disabled={noQuestionnaires}
        >
          <Sparkles className="mr-2 h-4 w-4" /> Suggest with AI
        </Button>
      </div>

      {noQuestionnaires && (
        <p className="text-muted-foreground text-xs">
          Attach a questionnaire to this round first — briefing notes are written against its
          questions.
        </p>
      )}

      {/* Add form */}
      {panel === 'add' && !noQuestionnaires && (
        <EntryForm
          roundId={roundId}
          briefable={briefable}
          onDone={() => {
            setPanel('none');
            router.refresh();
          }}
          onCancel={() => setPanel('none')}
        />
      )}

      {/* AI suggest */}
      {panel === 'suggest' && !noQuestionnaires && (
        <SuggestForm
          roundId={roundId}
          briefable={briefable}
          onClose={() => setPanel('none')}
          onAdded={() => router.refresh()}
        />
      )}

      {/* List */}
      {entries.length === 0 ? (
        <div className="rounded-lg border">
          <CohortEmptyState
            icon={<BookText className="h-5 w-5" />}
            title="No briefing notes yet"
            body="Add facts, figures, or background the interviewer should know — attach a note to one question, or keep it general for the whole questionnaire."
          />
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map((group) => (
            <div key={group.versionId} className="space-y-2">
              <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                {group.title}
              </h3>
              <ul className="divide-y rounded-lg border">
                {group.items.map((entry) =>
                  editingId === entry.id ? (
                    <li key={entry.id} className="p-3">
                      <EntryForm
                        roundId={roundId}
                        briefable={briefable}
                        entry={entry}
                        onDone={() => {
                          setEditingId(null);
                          router.refresh();
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    </li>
                  ) : (
                    <li key={entry.id} className="flex items-start gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{entry.title}</span>
                          <SourceBadge source={entry.source} />
                          <span className="text-muted-foreground inline-flex items-center gap-1 text-[0.7rem]">
                            {entry.questionSlotId ? (
                              <span className="max-w-[18rem] truncate">
                                ↳ {entry.questionPrompt ?? 'Question (removed)'}
                              </span>
                            ) : (
                              <span className="text-[color:var(--cq-accent)]">General</span>
                            )}
                          </span>
                        </div>
                        <p className="text-muted-foreground line-clamp-2 text-xs">
                          {entry.content}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label="Edit note"
                          onClick={() => {
                            setPanel('none');
                            setEditingId(entry.id);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive h-8 w-8"
                          aria-label="Delete note"
                          disabled={pendingDeleteId === entry.id}
                          onClick={() => void deleteEntry(entry.id)}
                        >
                          {pendingDeleteId === entry.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </li>
                  )
                )}
              </ul>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

/* ── Add / edit form ──────────────────────────────────────────────────────────── */

function EntryForm({
  roundId,
  briefable,
  entry,
  onDone,
  onCancel,
}: {
  roundId: string;
  briefable: BriefableQuestionnaire[];
  entry?: RoundContextEntryView;
  onDone: () => void;
  onCancel: () => void;
}) {
  const isEdit = entry !== undefined;
  // On edit the version is immutable; preselect it. On add, default to the first questionnaire.
  const [versionId, setVersionId] = useState(entry?.versionId ?? briefable[0]?.versionId ?? '');
  const [attribution, setAttribution] = useState(entry?.questionSlotId ?? GENERAL);
  const [title, setTitle] = useState(entry?.title ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedQ = briefable.find((b) => b.versionId === versionId);
  const questions = selectedQ?.questions ?? [];

  const upload = async (file: File) => {
    setUploading(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiClient.post<{ text: string }>(API.APP.ROUNDS.contextParse(roundId), {
        body: form,
      });
      setContent((prev) => (prev.trim() ? `${prev}\n\n${res.text}` : res.text).slice(0, 5000));
    } catch (e) {
      setErr(e instanceof APIClientError ? e.message : 'Could not read that document.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      setErr('A title and content are both required.');
      return;
    }
    setBusy(true);
    setErr(null);
    const questionSlotId = attribution === GENERAL ? null : attribution;
    try {
      if (isEdit) {
        await apiClient.patch(API.APP.ROUNDS.contextEntry(roundId, entry.id), {
          body: { questionSlotId, title: title.trim(), content: content.trim() },
        });
      } else {
        await apiClient.post(API.APP.ROUNDS.context(roundId), {
          body: { versionId, questionSlotId, title: title.trim(), content: content.trim() },
        });
      }
      onDone();
    } catch (e) {
      setErr(e instanceof APIClientError ? e.message : 'Could not save the note.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 text-sm">
          <span className="font-medium">Questionnaire</span>
          <Select
            value={versionId}
            onValueChange={(v) => {
              setVersionId(v);
              setAttribution(GENERAL);
            }}
            disabled={isEdit}
          >
            <SelectTrigger aria-label="Questionnaire">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              {briefable.map((b) => (
                <SelectItem key={b.versionId} value={b.versionId}>
                  {b.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5 text-sm">
          <span className="font-medium">Attach to</span>
          <Select value={attribution} onValueChange={setAttribution}>
            <SelectTrigger aria-label="Attach to">
              <SelectValue placeholder="General" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GENERAL}>General (whole questionnaire)</SelectItem>
              {questions.map((q) => (
                <SelectItem key={q.id} value={q.id}>
                  {q.prompt.length > 70 ? `${q.prompt.slice(0, 70)}…` : q.prompt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5 text-sm">
        <span className="font-medium">Title</span>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Last year's revenue"
          maxLength={200}
          aria-label="Briefing note title"
        />
      </div>

      <div className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">Content</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
            )}
            Upload document
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.md,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </div>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Facts, figures, or background the interviewer can draw on…"
          rows={4}
          maxLength={5000}
          aria-label="Briefing note content"
        />
      </div>

      {err && <p className="text-destructive text-xs">{err}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? 'Save changes' : 'Add note'}
        </Button>
      </div>
    </div>
  );
}

/* ── AI suggest ───────────────────────────────────────────────────────────────── */

interface Proposal {
  questionSlotId: string | null;
  title: string;
  content: string;
}

function SuggestForm({
  roundId,
  briefable,
  onClose,
  onAdded,
}: {
  roundId: string;
  briefable: BriefableQuestionnaire[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [versionId, setVersionId] = useState(briefable[0]?.versionId ?? '');
  const [sourceText, setSourceText] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [addedIdx, setAddedIdx] = useState<Set<number>>(new Set());
  const [pendingIdx, setPendingIdx] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const promptByQuestion = useMemo(() => {
    const map = new Map<string, string>();
    const q = briefable.find((b) => b.versionId === versionId);
    for (const item of q?.questions ?? []) map.set(item.id, item.prompt);
    return map;
  }, [briefable, versionId]);

  const upload = async (file: File) => {
    setUploading(true);
    setErr(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiClient.post<{ text: string }>(API.APP.ROUNDS.contextParse(roundId), {
        body: form,
      });
      setSourceText((prev) => (prev.trim() ? `${prev}\n\n${res.text}` : res.text));
    } catch (e) {
      setErr(e instanceof APIClientError ? e.message : 'Could not read that document.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const suggest = async () => {
    setBusy(true);
    setErr(null);
    setProposals(null);
    setAddedIdx(new Set());
    try {
      const res = await apiClient.post<{ entries: Proposal[] }>(
        API.APP.ROUNDS.contextSuggest(roundId),
        { body: { versionId, ...(sourceText.trim() ? { sourceText: sourceText.trim() } : {}) } }
      );
      setProposals(res.entries);
    } catch (e) {
      setErr(e instanceof APIClientError ? e.message : 'Could not generate suggestions.');
    } finally {
      setBusy(false);
    }
  };

  const accept = async (p: Proposal, idx: number) => {
    setPendingIdx(idx);
    setErr(null);
    try {
      await apiClient.post(API.APP.ROUNDS.context(roundId), {
        body: {
          versionId,
          questionSlotId: p.questionSlotId,
          title: p.title,
          content: p.content,
          source: 'ai_suggested',
        },
      });
      setAddedIdx((prev) => new Set(prev).add(idx));
      onAdded();
    } catch (e) {
      setErr(e instanceof APIClientError ? e.message : 'Could not add that note.');
    } finally {
      setPendingIdx(null);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-[color:var(--cq-accent)]" /> Suggest briefing notes
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-1.5 text-sm">
        <span className="font-medium">Questionnaire</span>
        <Select value={versionId} onValueChange={setVersionId}>
          <SelectTrigger aria-label="Questionnaire">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {briefable.map((b) => (
              <SelectItem key={b.versionId} value={b.versionId}>
                {b.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">
            Source material <span className="text-muted-foreground font-normal">(optional)</span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-3.5 w-3.5" />
            )}
            Upload document
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.md,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </div>
        <Textarea
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="Paste or upload background material. Leave empty to get prompts for the kinds of facts worth gathering."
          rows={4}
          aria-label="Source material"
        />
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={() => void suggest()} disabled={busy || versionId === ''}>
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {proposals ? 'Regenerate' : 'Suggest'}
        </Button>
      </div>

      {err && <p className="text-destructive text-xs">{err}</p>}

      {proposals && proposals.length === 0 && (
        <p className="text-muted-foreground text-xs">No suggestions came back — try again.</p>
      )}

      {proposals && proposals.length > 0 && (
        <ul className="divide-y rounded-md border">
          {proposals.map((p, idx) => {
            const added = addedIdx.has(idx);
            const attached = p.questionSlotId ? promptByQuestion.get(p.questionSlotId) : null;
            return (
              <li key={idx} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{p.title}</span>
                    <span className="text-muted-foreground text-[0.7rem]">
                      {attached ? (
                        <span className="max-w-[16rem] truncate">↳ {attached}</span>
                      ) : (
                        <span className="text-[color:var(--cq-accent)]">General</span>
                      )}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">{p.content}</p>
                </div>
                <Button
                  size="sm"
                  variant={added ? 'ghost' : 'outline'}
                  className="shrink-0"
                  disabled={added || pendingIdx === idx}
                  onClick={() => void accept(p, idx)}
                >
                  {pendingIdx === idx ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : added ? null : (
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {added ? 'Added' : 'Add'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
