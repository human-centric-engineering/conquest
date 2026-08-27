'use client';

/**
 * DEMO-ONLY (brand kit): a colour input for the demo-client form — swatch and hex together.
 *
 * Every colour on this form was a plain text box: the admin typed `#280039` and found out
 * what it looked like by saving. A native `<input type="color">` costs nothing, gives the
 * OS picker (including an eyedropper on macOS and Chrome), and keeps the hex field beside it
 * for the far more common case — pasting the value straight out of a brand guideline.
 *
 * ## The unset state is the hard part
 *
 * Blank is meaningful everywhere on this form: it means "no colour, use the default", and for
 * ink and the dark canvas it means "derive it for me", which is the path most clients take.
 * But a native colour input has no empty state — it must show SOME colour, and the browser's
 * default is black. Rendered plainly, an untouched field therefore reads as "this colour is
 * black" sitting next to a placeholder saying otherwise.
 *
 * So the swatch is a styled span with the real input laid transparently over it: unset draws
 * a muted diagonal slash (visibly nothing), and clicking still opens the OS picker — seeded
 * from `placeholder` when there is one, so the admin starts at the suggested colour rather
 * than at black. The control never calls `onChange` by itself, so an untouched field stores
 * nothing no matter what the picker was seeded with.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { FormError } from '@/components/forms/form-error';
import { cn } from '@/lib/utils';
import { HEX_COLOR_PATTERN } from '@/lib/app/questionnaire/theming';

interface BrandColorFieldProps {
  id: string;
  label: string;
  help: React.ReactNode;
  /** The current hex value, or '' for "not set". */
  value: string;
  onChange: (value: string) => void;
  /**
   * Shown in the hex box, and — when it is itself a hex — used to seed the OS picker so an
   * untouched swatch opens on the suggested colour instead of black.
   */
  placeholder?: string;
  disabled?: boolean;
  error?: string;
}

export function BrandColorField({
  id,
  label,
  help,
  value,
  onChange,
  placeholder,
  disabled,
  error,
}: BrandColorFieldProps) {
  const trimmed = value.trim();
  const isSet = HEX_COLOR_PATTERN.test(trimmed);
  // Only a hex placeholder can seed the picker — several fields placeholder with prose
  // ("Leave blank to derive it"), which is exactly where the unset state matters most.
  const seed =
    placeholder && HEX_COLOR_PATTERN.test(placeholder.trim()) ? placeholder.trim() : '#808080';

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="flex items-center gap-1">
        {label}
        <FieldHelp title={label}>{help}</FieldHelp>
      </Label>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'relative inline-flex h-9 w-9 shrink-0 overflow-hidden rounded border',
            // Unset reads as "nothing chosen", not as a colour: a dashed edge and a slash
            // through it, both in muted tones so it recedes rather than looking like an error.
            !isSet && 'border-dashed',
            disabled && 'opacity-50'
          )}
          style={isSet ? { backgroundColor: trimmed } : undefined}
        >
          {!isSet && (
            <svg
              aria-hidden
              viewBox="0 0 36 36"
              className="text-muted-foreground/50 absolute inset-0 h-full w-full"
            >
              <line x1="4" y1="32" x2="32" y2="4" stroke="currentColor" strokeWidth="2" />
            </svg>
          )}
          <input
            type="color"
            // Labelled apart from the hex box: two controls for one value, and a screen reader
            // announcing both as "Canvas colour" gives no way to tell them apart.
            aria-label={`${label} picker`}
            value={isSet ? trimmed : seed}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            // Transparent and stretched over the swatch: the span owns the appearance (a
            // colour input cannot render an "unset" state), the input owns the behaviour.
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          />
        </span>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="font-mono"
          // Only once there is something to be wrong ABOUT: an empty field is a valid
          // "unset", and flagging it would mark most of this form invalid on first paint.
          aria-invalid={trimmed !== '' && !isSet}
        />
      </div>
      <FormError message={error} />
    </div>
  );
}
