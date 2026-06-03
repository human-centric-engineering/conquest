'use client';

/**
 * TagVocabularyEditor (F2.2) — the version's tag vocabulary CRUD, rendered in the
 * `?edit=1` authoring surface above the sections.
 *
 * Each row renames (on blur) and recolours (select) one tag, or deletes it; the
 * footer adds a new tag. Every write goes through the parent's `run` runner, so the
 * fork notice + refetch are handled centrally (editing a launched version's
 * vocabulary forks a new draft, exactly like a structural edit). Local input state
 * re-syncs from props after each refetch.
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { API } from '@/lib/api/endpoints';
import { TAG_COLORS, type TagColor } from '@/lib/app/questionnaire/types';
import type { TagView } from '@/lib/app/questionnaire/views';

import { tagColorClass } from '@/components/admin/questionnaires/tag-chip';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

/** Sentinel for the "no colour" Select option (Select values must be non-empty). */
const NO_COLOR = '__none__';

function ColorDot({ color }: { color: TagColor | null }) {
  return <span className={`inline-block h-3 w-3 rounded-full border ${tagColorClass(color)}`} />;
}

export function TagVocabularyEditor({
  questionnaireId,
  versionId,
  tags,
  run,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  tags: TagView[];
  run: RunMutation;
  busy: boolean;
}) {
  const [newLabel, setNewLabel] = useState('');

  const collectionPath = API.APP.QUESTIONNAIRES.versionTags(questionnaireId, versionId);
  const tagPath = (tagId: string) =>
    API.APP.QUESTIONNAIRES.versionTagById(questionnaireId, versionId, tagId);

  const addTag = () => {
    const label = newLabel.trim();
    if (!label) return;
    setNewLabel('');
    run(() => ['POST', collectionPath, { label }]);
  };

  return (
    <section className="space-y-3 rounded-md border p-4">
      <Label className="text-sm font-medium">
        Tags{' '}
        <FieldHelp title="Question tags">
          A per-version vocabulary you can assign to questions. Used by analytics filtering and the
          adaptive selection strategy. Editing a launched version&rsquo;s tags forks a new draft.
        </FieldHelp>
      </Label>

      {tags.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">No tags yet.</p>
      ) : (
        <ul className="space-y-2">
          {tags.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              busy={busy}
              onRename={(label) => run(() => ['PATCH', tagPath(tag.id), { label }])}
              onRecolour={(color) => run(() => ['PATCH', tagPath(tag.id), { color }])}
              onDelete={() => run(() => ['DELETE', tagPath(tag.id), undefined])}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder="New tag label"
          className="h-8 max-w-xs text-sm"
          disabled={busy}
          aria-label="New tag label"
        />
        <Button variant="outline" size="sm" disabled={busy || !newLabel.trim()} onClick={addTag}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add tag
        </Button>
      </div>
    </section>
  );
}

function TagRow({
  tag,
  busy,
  onRename,
  onRecolour,
  onDelete,
}: {
  tag: TagView;
  busy: boolean;
  onRename: (label: string) => void;
  onRecolour: (color: TagColor | null) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(tag.label);
  useEffect(() => setLabel(tag.label), [tag.label]);

  const saveLabel = () => {
    const next = label.trim();
    if (next && next !== tag.label) onRename(next);
  };

  return (
    <li className="flex items-center gap-2">
      <Select
        value={tag.color ?? NO_COLOR}
        disabled={busy}
        onValueChange={(v) => onRecolour(v === NO_COLOR ? null : (v as TagColor))}
      >
        <SelectTrigger className="h-8 w-32 text-xs" aria-label={`Colour for ${tag.label}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_COLOR}>
            <span className="flex items-center gap-2">
              <ColorDot color={null} /> No colour
            </span>
          </SelectItem>
          {TAG_COLORS.map((c) => (
            <SelectItem key={c} value={c}>
              <span className="flex items-center gap-2 capitalize">
                <ColorDot color={c} /> {c}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={saveLabel}
        disabled={busy}
        className="h-8 max-w-xs text-sm"
        aria-label={`Tag label (${tag.label})`}
      />

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={busy}
        aria-label={`Delete tag ${tag.label}`}
        onClick={onDelete}
      >
        <Trash2 className="text-destructive h-4 w-4" />
      </Button>
    </li>
  );
}
