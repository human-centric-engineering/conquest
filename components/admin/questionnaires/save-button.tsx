'use client';

/**
 * SaveButton — a Save action button that flashes a brief "Saved" check on success.
 *
 * Mirrors the saved-state pattern already used across the orchestration forms
 * (agent/provider/capability): idle → saving (spinner) → saved (check, then reverts).
 * Use it for app-level "stay on the page" saves (questionnaire Settings, Data slots) so
 * the admin gets the same confirmation feedback as elsewhere in the platform.
 *
 * The handler owns its own error surfacing. SaveButton only reflects the outcome in the
 * button: it shows the check when `onSave` resolves, and silently reverts to idle when
 * `onSave` throws or resolves `false` (so a runner that swallows errors and returns a
 * success flag can suppress the check on failure).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Loader2 } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';

type Phase = 'idle' | 'saving' | 'saved';

export interface SaveButtonProps extends Omit<ButtonProps, 'onClick' | 'type'> {
  /**
   * Runs the save. Resolving shows the check; throwing or resolving exactly `false`
   * reverts to idle without a check (the handler surfaces its own error).
   */
  onSave: () => boolean | void | Promise<boolean | void>;
  /** Idle label. */
  children?: ReactNode;
  savingLabel?: ReactNode;
  savedLabel?: ReactNode;
  /** How long the check stays before reverting to idle (ms). */
  savedDurationMs?: number;
}

export function SaveButton({
  onSave,
  children = 'Save',
  savingLabel = 'Saving…',
  savedLabel = 'Saved',
  savedDurationMs = 2000,
  disabled,
  ...props
}: SaveButtonProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const handleClick = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    setPhase('saving');
    try {
      const result = await onSave();
      if (!mounted.current) return;
      if (result === false) {
        setPhase('idle');
        return;
      }
      setPhase('saved');
      timer.current = setTimeout(() => {
        if (mounted.current) setPhase('idle');
      }, savedDurationMs);
    } catch {
      // The handler surfaces its own error; just clear the saving state.
      if (mounted.current) setPhase('idle');
    }
  }, [onSave, savedDurationMs]);

  return (
    <Button
      {...props}
      type="button"
      disabled={disabled || phase === 'saving' || phase === 'saved'}
      onClick={() => void handleClick()}
    >
      {phase === 'saving' ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          {savingLabel}
        </>
      ) : phase === 'saved' ? (
        <>
          <Check className="h-4 w-4" />
          {savedLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
