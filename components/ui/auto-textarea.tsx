'use client';

/**
 * Textarea that grows with its content up to a cap, then scrolls.
 *
 * Wraps the base `Textarea`: after every value change it resets the height and sets it to the
 * content's scrollHeight (clamped to `maxHeight`), so the field expands as you type instead of
 * forcing a tiny fixed window. A `min-h` class still floors it. JS-driven rather than CSS
 * `field-sizing` for cross-browser reliability.
 */

import * as React from 'react';

import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface AutoTextareaProps extends React.ComponentProps<'textarea'> {
  /** Max pixel height before the textarea scrolls instead of growing. Default 360. */
  maxHeight?: number;
}

export const AutoTextarea = React.forwardRef<HTMLTextAreaElement, AutoTextareaProps>(
  ({ value, maxHeight = 360, className, onChange, ...props }, forwardedRef) => {
    const innerRef = React.useRef<HTMLTextAreaElement | null>(null);

    const setRefs = (node: HTMLTextAreaElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    };

    const resize = React.useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = 'auto';
      const next = Math.min(el.scrollHeight, maxHeight);
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }, [maxHeight]);

    // Re-fit on mount and whenever the value changes (incl. external resets).
    React.useLayoutEffect(resize, [resize, value]);

    return (
      <Textarea
        ref={setRefs}
        value={value}
        onChange={(e) => {
          onChange?.(e);
          resize();
        }}
        className={cn('resize-none', className)}
        {...props}
      />
    );
  }
);
AutoTextarea.displayName = 'AutoTextarea';
