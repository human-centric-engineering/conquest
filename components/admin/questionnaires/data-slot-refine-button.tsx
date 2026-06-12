'use client';

/**
 * Per-slot "Refine with AI" control (Data Slots feature).
 *
 * Opens a popover with a free-text instruction box; on submit it POSTs the current slot + the
 * instructions to the refine endpoint, which runs ONE structured LLM call and returns a single
 * refined slot (name, description, theme, and re-suggested question coverage). The result is handed
 * back via `onRefined` for the parent to splice into its working set in place — nothing is persisted
 * server-side (a refine is just an LLM-assisted edit, committed with the rest on Save).
 */

import { useId, useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { API } from '@/lib/api/endpoints';
import {
  authoringMutate,
  AuthoringError,
} from '@/components/admin/questionnaires/authoring-mutate';
import type { GeneratedDataSlot } from '@/lib/app/questionnaire/data-slots';

interface RefineSlotInput {
  name: string;
  description: string;
  theme: string;
  questionKeys: string[];
}

export interface DataSlotRefineButtonProps {
  questionnaireId: string;
  versionId: string;
  /** The slot as it currently stands in the working set (sent to the model as context). */
  slot: RefineSlotInput;
  /** The other slots' names + themes, so the refiner stays distinct + keeps the theme consistent. */
  siblingSlots?: { name: string; theme: string }[];
  /** Disable while another action (generate/save/discard) is in flight. */
  disabled?: boolean;
  /** Called with the refined slot for the parent to splice into the working set. */
  onRefined: (slot: GeneratedDataSlot) => void;
}

/** Shape of the refine endpoint's success payload (fail-soft: `slot` is null on a refiner error). */
interface RefineResponse {
  slot: GeneratedDataSlot | null;
  diagnostic?: string;
  diagnosticMessage?: string;
}

export function DataSlotRefineButton({
  questionnaireId,
  versionId,
  slot,
  siblingSlots,
  disabled,
  onRefined,
}: DataSlotRefineButtonProps) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Unique per instance — many cards each render this control, so a shared static id would
  // produce duplicate ids and mis-associate the label/textarea.
  const instructionsId = useId();

  const submit = async () => {
    const trimmed = instructions.trim();
    if (!trimmed || refining) return;
    setRefining(true);
    setError(null);
    try {
      const res = await authoringMutate<RefineResponse>(
        'POST',
        API.APP.QUESTIONNAIRES.versionDataSlotsRefine(questionnaireId, versionId),
        {
          instructions: trimmed,
          slot: {
            name: slot.name,
            description: slot.description,
            theme: slot.theme,
            questionKeys: slot.questionKeys,
          },
          ...(siblingSlots && siblingSlots.length > 0 ? { siblingSlots } : {}),
        }
      );
      if (res.data.slot) {
        onRefined(res.data.slot);
        setInstructions('');
        setOpen(false);
      } else {
        setError(res.data.diagnosticMessage ?? 'The refiner did not return a slot. Try again.');
      }
    } catch (err) {
      setError(err instanceof AuthoringError ? err.message : 'Could not refine this slot.');
    } finally {
      setRefining(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Don't let an outside-click dismiss the popover mid-call.
        if (refining) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={disabled}>
          <Wand2 className="mr-1 h-3.5 w-3.5" /> Refine with AI
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-2">
        <div className="space-y-1">
          <Label htmlFor={instructionsId} className="text-xs font-medium">
            How should the agent refine this slot?
          </Label>
          <p className="text-muted-foreground text-xs">
            It can rewrite the name, description, and theme, and re-suggest which questions the slot
            covers.
          </p>
        </div>
        <AutoTextarea
          id={instructionsId}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits, like the chat composer.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="e.g. Make it focus on enterprise buyers, and split out pricing into its own concern."
          className="min-h-20 text-sm"
          disabled={refining}
        />
        {error && <p className="text-destructive text-xs">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={refining}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={refining || !instructions.trim()}
          >
            {refining ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="mr-1.5 h-4 w-4" />
            )}
            Refine
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
