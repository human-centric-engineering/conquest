'use client';

/**
 * PersonaPicker — the respondent "Choose your interviewer" surface (F-persona).
 *
 * A carousel surface (sibling to {@link QuestionnaireSplash}) shown when the admin lets respondents
 * choose their interviewer: a grid of persona cards (name + description) with a pinned Continue CTA.
 * Choosing a card persists the choice (the workspace PATCHes it) and highlights it; Continue slides
 * to the conversation. Also reused as the mid-chat switcher — same surface, reached via the lifecycle
 * bar. Inherits the client's brand via the page's `BrandThemeProvider` CSS vars.
 */

import { ArrowRight, Check, Drama } from 'lucide-react';

import { cn } from '@/lib/utils';

const ACCENT = 'var(--app-accent-color, var(--color-primary))';
const ACCENT_SOFT =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 9%, transparent)';
const ACCENT_HAIRLINE =
  'color-mix(in srgb, var(--app-accent-color, var(--color-primary)) 25%, transparent)';
const CTA_FILL =
  'var(--app-cta-gradient, var(--app-cta-color, var(--cq-accent, var(--color-primary))))';

/** The respondent-facing shape of one persona (the tone block never reaches the client). */
export interface PersonaChoice {
  key: string;
  label: string;
  description: string;
}

export interface PersonaPickerProps {
  personas: PersonaChoice[];
  /** The respondent's current choice, or `null` when they haven't chosen (⇒ default is highlighted). */
  selectedKey: string | null;
  /** The default persona key — highlighted until the respondent picks another. */
  defaultKey: string;
  /** Disable interaction while a choice is being persisted. */
  busy?: boolean;
  /** Persist the chosen persona (the workspace PATCHes + records it). */
  onChoose: (key: string) => void;
  /** Advance out of the picker (to the conversation, or back to it for the switcher). */
  onContinue: () => void;
  /** CTA label — "Start the conversation" on the pre-chat step, "Done" for the switcher. */
  continueLabel?: string;
  /** Heading — differs slightly between the pre-chat step and the mid-chat switcher. */
  heading?: string;
  subheading?: string;
  /** Right-align the Continue CTA (the pre-chat step). Defaults to left-aligned (the modal switcher). */
  alignEnd?: boolean;
}

export function PersonaPicker({
  personas,
  selectedKey,
  defaultKey,
  busy = false,
  onChoose,
  onContinue,
  continueLabel = 'Start the conversation',
  heading = 'Choose your interviewer',
  subheading = 'Each interviewer asks in their own style. Pick whoever you’d most like to talk with — you can change your mind at any time.',
  alignEnd = false,
}: PersonaPickerProps) {
  // What's visibly selected: the respondent's explicit choice, else the configured default.
  const activeKey = selectedKey ?? defaultKey;
  // The admin's default interviewer leads the grid (badged "Default"), then the rest in their
  // canonical order — so the recommended voice is the first card the respondent sees.
  const orderedPersonas = [
    ...personas.filter((p) => p.key === defaultKey),
    ...personas.filter((p) => p.key !== defaultKey),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header + persona grid share ONE scroll region, so on short viewports the header scrolls away
          with the cards instead of eating fixed height at the top; only the Continue CTA stays pinned. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-4 text-center sm:pt-10">
          <span
            className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-2xl"
            style={{ backgroundColor: ACCENT_SOFT, color: ACCENT }}
          >
            <Drama className="h-5 w-5" aria-hidden="true" />
          </span>
          <h1 className="text-foreground text-xl font-semibold sm:text-2xl">{heading}</h1>
          <p className="text-muted-foreground mx-auto mt-1.5 max-w-xl text-sm">{subheading}</p>
        </div>
        <div className="mx-auto grid w-full max-w-3xl gap-3 px-4 pb-4 sm:grid-cols-2">
          {orderedPersonas.map((persona) => {
            const active = persona.key === activeKey;
            const isDefault = persona.key === defaultKey;
            return (
              <button
                key={persona.key}
                type="button"
                onClick={() => onChoose(persona.key)}
                disabled={busy}
                aria-pressed={active}
                className={cn(
                  'group relative flex flex-col items-start rounded-xl border p-4 text-left transition',
                  'hover:border-transparent focus-visible:ring-2 focus-visible:outline-none',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  active ? 'border-transparent shadow-sm' : 'border-border'
                )}
                style={
                  active
                    ? { backgroundColor: ACCENT_SOFT, boxShadow: `inset 0 0 0 1.5px ${ACCENT}` }
                    : undefined
                }
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="text-foreground text-sm font-semibold">
                      {persona.label.trim() || 'Interviewer'}
                    </span>
                    {isDefault && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
                        style={{ backgroundColor: ACCENT_SOFT, color: ACCENT }}
                      >
                        Default
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition',
                      active ? 'border-transparent text-white' : 'border-border text-transparent'
                    )}
                    style={active ? { backgroundColor: ACCENT } : { borderColor: ACCENT_HAIRLINE }}
                    aria-hidden="true"
                  >
                    <Check className="h-3 w-3" />
                  </span>
                </span>
                {persona.description.trim() && (
                  <span className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {persona.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className={cn(
          'border-border/60 mx-auto flex w-full max-w-3xl shrink-0 border-t px-4 py-2.5',
          alignEnd && 'sm:justify-end'
        )}
      >
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className={cn(
            'inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition',
            'hover:opacity-95 focus-visible:ring-2 focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto'
          )}
          style={{ background: CTA_FILL }}
        >
          {continueLabel}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
