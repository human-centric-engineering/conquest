'use client';

/**
 * QuestionTagsEditor (F2.2) — assign/unassign a question's tags.
 *
 * Renders the question's current tags as chips plus a popover of the version's
 * whole vocabulary as checkboxes. Toggling a checkbox fires the replace-set
 * `PUT …/questions/:id/tags` with the question's full new tag-id set (the API is
 * idempotent and version-checks the ids). Writes go through the parent's `run`
 * runner, so the fork notice + refetch are handled centrally.
 */

import { useEffect, useRef } from 'react';
import { Tag } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { API } from '@/lib/api/endpoints';
import type { QuestionSlotView, TagView } from '@/lib/app/questionnaire/views';

import { TagChip } from '@/components/admin/questionnaires/tag-chip';
import type { RunMutation } from '@/components/admin/questionnaires/version-editor-types';

export function QuestionTagsEditor({
  questionnaireId,
  versionId,
  question,
  tags,
  run,
  busy,
}: {
  questionnaireId: string;
  versionId: string;
  question: QuestionSlotView;
  tags: TagView[];
  run: RunMutation;
  busy: boolean;
}) {
  const assigned = new Set(question.tags.map((t) => t.id));
  const path = API.APP.QUESTIONNAIRES.versionQuestionTags(questionnaireId, versionId, question.id);

  // Two checkboxes toggled before the refetch lands would both read the same
  // props-derived `assigned`, so the second PUT would clobber the first. Track the
  // optimistic set in a ref so each toggle builds on the previous one; reset it once
  // fresh props arrive.
  const pendingRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    pendingRef.current = null;
  }, [question.tags]);

  const toggle = (tagId: string) => {
    const next = new Set(pendingRef.current ?? assigned);
    if (next.has(tagId)) next.delete(tagId);
    else next.add(tagId);
    pendingRef.current = next;
    run(() => ['PUT', path, { tagIds: [...next] }]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {question.tags.map((t) => (
        <TagChip key={t.id} tag={t} />
      ))}

      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-6 px-2 text-xs"
            disabled={busy || tags.length === 0}
            aria-label="Edit tags"
          >
            <Tag className="mr-1 h-3.5 w-3.5" />
            {question.tags.length === 0 ? 'Add tags' : 'Edit'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          {tags.length === 0 ? (
            <p className="text-muted-foreground p-1 text-xs">No tags defined for this version.</p>
          ) : (
            <ul className="space-y-1">
              {tags.map((tag) => (
                <li key={tag.id} className="flex items-center gap-2 rounded px-1 py-1">
                  <Checkbox
                    id={`qtag-${question.id}-${tag.id}`}
                    checked={assigned.has(tag.id)}
                    disabled={busy}
                    onCheckedChange={() => toggle(tag.id)}
                    aria-label={tag.label}
                  />
                  <label htmlFor={`qtag-${question.id}-${tag.id}`} className="cursor-pointer">
                    <TagChip tag={tag} />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
