'use client';

/**
 * In-chat interviewer switcher (F-persona) — the `indicator` / `both` presentation of persona
 * selection, controlled by the admin's `personaSelection.switcher` setting.
 *
 * {@link CurrentInterviewerChip} is a compact "Interviewer: {name}" pill (with a dropdown-style
 * affordance) that rides the
 * session lifecycle strip; pressing it runs the workspace's change action. In `both` mode that action
 * slides the carousel back to the "Choose your interviewer" page; in `indicator` mode there is no such
 * page, so it opens {@link PersonaSwitcherModal} — the same {@link PersonaPicker} grid inside a Dialog.
 * The workspace owns the state (current key, choice handler, open state); these are presentational.
 */

import { ChevronsUpDown, Drama } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  PersonaPicker,
  type PersonaChoice,
} from '@/components/app/questionnaire/persona/persona-picker';

const ACCENT = 'var(--app-accent-color, var(--color-primary))';
const ACCENT_SOFT =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 9%, transparent)';
const ACCENT_HAIRLINE =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 30%, transparent)';

/** The "Interviewer: {name}" pill + dropdown affordance. Pressing it runs the workspace's change action. */
export function CurrentInterviewerChip({
  label,
  onChange,
  busy = false,
  className,
}: {
  /** The current interviewer's display name (chosen persona, else the default). */
  label: string;
  /** Open the switcher — a modal in `indicator` mode, the carousel page in `both` mode. */
  onChange: () => void;
  busy?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={busy}
      aria-label={`Change interviewer — currently ${label}`}
      className={cn(
        'group inline-flex max-w-[60vw] min-w-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium shadow-sm transition sm:max-w-none sm:px-3',
        'hover:brightness-[0.97] focus-visible:ring-2 focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className
      )}
      // Accent-tinted fill + hairline so the pill reads as a tappable control, not a static label.
      style={{ backgroundColor: ACCENT_SOFT, borderColor: ACCENT_HAIRLINE }}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: ACCENT_SOFT, color: ACCENT }}
      >
        <Drama className="h-2.5 w-2.5" aria-hidden="true" />
      </span>
      {/* Keep the "Interviewer:" prefix on normal mobile; drop it only ≤360px so the name keeps its
          room. The name truncates as a backstop for very long persona labels. */}
      <span className="text-muted-foreground shrink-0 max-[360px]:hidden">Interviewer:</span>
      <span className="text-foreground truncate">{label}</span>
      {/* Dropdown-style affordance: signals the pill opens the interviewer picker (replaces the old
          "· Change" text). */}
      <ChevronsUpDown
        className="h-3.5 w-3.5 shrink-0 opacity-70 transition group-hover:opacity-100"
        style={{ color: ACCENT }}
        aria-hidden="true"
      />
    </button>
  );
}

/** The `indicator`-mode modal: the persona picker grid in a Dialog. Choosing persists immediately. */
export function PersonaSwitcherModal({
  open,
  onOpenChange,
  personas,
  selectedKey,
  defaultKey,
  onChoose,
  busy = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personas: PersonaChoice[];
  selectedKey: string | null;
  defaultKey: string;
  onChoose: (key: string) => void;
  busy?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>Change your interviewer</DialogTitle>
          <DialogDescription>
            Pick which interviewer you talk with. Your choice applies from your next answer.
          </DialogDescription>
        </DialogHeader>
        <div className="h-[70vh] max-h-[38rem]">
          <PersonaPicker
            personas={personas}
            selectedKey={selectedKey}
            defaultKey={defaultKey}
            busy={busy}
            onChoose={onChoose}
            onContinue={() => onOpenChange(false)}
            continueLabel="Done"
            heading="Change your interviewer"
            subheading="Pick whoever you’d most like to talk with — your choice applies from your next answer."
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
