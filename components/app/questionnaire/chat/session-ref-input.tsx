'use client';

/**
 * SessionRefInput — the segmented entry field for a session support reference (`7F3K-9M2P`).
 *
 * The code is a FIXED shape — 8 Crockford base32 characters, grouped 4+4 — so the field shows that
 * shape instead of hiding it behind placeholder text: eight cells with the grouping dash drawn
 * between them. The respondent can see at a glance how much is left to type, and a code read aloud
 * from another device lands one character per box.
 *
 * One real `<input>` sits invisibly over the cells, so this stays a single labelled field for
 * assistive tech and the browser: paste works anywhere in the group, mobile gets one keyboard, and
 * there is no eight-input focus dance. The cells are pure presentation, driven by `value`.
 *
 * Input is folded through {@link normalizeSessionRef} on every keystroke — uppercased, dashes and
 * spaces dropped, and the look-alikes a human mistypes (`O`→`0`, `I`/`L`→`1`) corrected in place —
 * so a respondent literally cannot type a code the lookup would then reject on formatting.
 *
 * @see lib/app/questionnaire/session-ref.ts
 * @see components/app/questionnaire/chat/resume-by-ref-form.tsx
 */

import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';

import { cn } from '@/lib/utils';
import { normalizeSessionRef, SESSION_REF_LENGTH } from '@/lib/app/questionnaire/session-ref';

/** Cell index the grouping dash follows (`7F3K` · `9M2P`). */
const GROUP_AT = SESSION_REF_LENGTH / 2;

const ACCENT = 'var(--app-accent-color, var(--cq-accent, var(--color-primary)))';

/** Set once on the wrapper and inherited by every cell, so the accent chain is written out once. */
const CELL_VARS: Record<string, string> = { '--session-ref-accent': ACCENT };

export interface SessionRefInputProps {
  /** The raw code so far — already normalised, never longer than {@link SESSION_REF_LENGTH}. */
  value: string;
  onChange: (next: string) => void;
  /** Fired once the final character lands — lets the form submit without a button press. */
  onComplete?: (code: string) => void;
  disabled?: boolean;
  /** Paints the cells in the destructive tone (a lookup that came back empty). */
  invalid?: boolean;
  /**
   * Move focus here on mount — for hosts that exist only to take this code, or that reveal the
   * field in response to a click (focus has to follow the disclosure). Done imperatively rather
   * than via the `autofocus` attribute, which fires before the browser has settled the page.
   */
  focusOnMount?: boolean;
  /** Id of the error/help text describing the field. */
  describedBy?: string;
  id?: string;
  className?: string;
}

export function SessionRefInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  focusOnMount = false,
  describedBy,
  id,
  className,
}: SessionRefInputProps) {
  const generatedId = useId();
  const inputId = id ?? `session-ref-${generatedId}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);

  // The caret is always at the end: the cells fill left to right, so an arbitrary click inside the
  // (invisible) input must not strand the insertion point mid-code.
  function caretToEnd() {
    const el = inputRef.current;
    if (!el) return;
    const end = el.value.length;
    if (el.selectionStart !== end || el.selectionEnd !== end) el.setSelectionRange(end, end);
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const next = normalizeSessionRef(e.target.value).slice(0, SESSION_REF_LENGTH);
    onChange(next);
    // Only on the transition INTO a complete code: with the length enforced here rather than by the
    // input, keystrokes against a full field re-enter this handler with an unchanged value, and
    // each one would otherwise fire another submit.
    if (next.length === SESSION_REF_LENGTH && next !== value) onComplete?.(next);
  }

  const chars = value.split('');
  const activeIndex = Math.min(value.length, SESSION_REF_LENGTH - 1);

  return (
    <div style={CELL_VARS} className={cn('relative inline-flex w-fit items-center', className)}>
      {/* The real field — invisible, but full-size and on top, so a tap anywhere in the group
          focuses it and native paste / autofill / IME all behave normally. */}
      <input
        ref={inputRef}
        id={inputId}
        value={value}
        onChange={handleChange}
        onSelect={caretToEnd}
        onClick={caretToEnd}
        onFocus={() => {
          setFocused(true);
          caretToEnd();
        }}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        // Not a one-time code: `off` keeps the browser from offering an SMS OTP here.
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        // Deliberately NO `maxLength`: the browser would clamp a pasted *grouped* code
        // (`7F3K-9M2P`, 9 chars) before the dash is stripped, silently eating the last character.
        // The ceiling is applied after normalisation instead.
        aria-label="Session reference code"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0 disabled:cursor-not-allowed"
      />

      {/* Sized to survive a 360px viewport inside a padded card: eight cells, seven gaps and the
          grouping dash all have to fit on one line — it must never wrap. */}
      <div aria-hidden className="flex items-center gap-0.5 sm:gap-1">
        {Array.from({ length: SESSION_REF_LENGTH }, (_, i) => {
          const char = chars[i];
          const filled = char !== undefined;
          // Only the cell the next character will land in reads as active, and only while the
          // (invisible) input actually holds focus.
          const active = i === activeIndex && focused && !disabled;
          return (
            <div key={i} className="flex items-center gap-0.5 sm:gap-1">
              {i === GROUP_AT && (
                <span className="text-muted-foreground/60 px-1 text-lg leading-none select-none">
                  –
                </span>
              )}
              <div
                className={cn(
                  'relative flex h-11 w-7 items-center justify-center rounded-lg border font-mono text-lg font-semibold transition-all duration-150 sm:h-12 sm:w-9 sm:text-xl',
                  filled
                    ? 'text-foreground bg-background'
                    : 'text-muted-foreground bg-muted/40 border-dashed',
                  invalid && 'border-destructive text-destructive bg-destructive/5',
                  !invalid && filled && 'border-[color:var(--session-ref-accent)]',
                  // Focus ring lives on the group's active cell — the real input is invisible.
                  !invalid &&
                    active &&
                    'border-[color:var(--session-ref-accent)] ring-2 ring-[color:var(--session-ref-accent)]/35'
                )}
              >
                {char ?? ''}
                {!filled && active && (
                  <span
                    className="cq-code-caret absolute h-5 w-px sm:h-6"
                    style={{ backgroundColor: ACCENT }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
