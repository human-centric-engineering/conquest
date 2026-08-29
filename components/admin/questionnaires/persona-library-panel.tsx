'use client';

/**
 * Persona library panel (F-persona) — the built-in-persona half of the "Interviewer voice" either/or.
 *
 * Rendered inside the merged "Interviewer tone & persona" SettingsGroup in `config-editor.tsx`, only
 * when the admin has picked "Built-in persona" mode (the outer mode toggle owns `personaSelection.enabled`;
 * this panel assumes it's on). The persona library is FIXED ({@link BUILT_IN_PERSONAS}) — a curated set
 * of named voices, not editable config. So this panel owns no persona editing: it lets the admin tick
 * WHICH of the built-in personas this questionnaire offers — grouped by the situation each was written
 * for ({@link PersonaCategory}) — pin which of those governs the interviewer, and optionally let
 * respondents switch among the offered ones (and how). An admin who wants a bespoke voice picks
 * "Custom voice" mode and uses the tone block instead.
 *
 * Every tick-box carries the persona's **respondent-facing description verbatim**, because the admin
 * deciding who to offer should be reading what the respondent will read. The rest — the system-prompt
 * prose that actually briefs the interviewer, and its tone dials — sits behind a per-persona
 * "More about {name}" toggle ({@link PersonaDetail}), so a library of this size stays scannable.
 * There is no separate preview of the pinned persona: the pinned one is a row like any other, marked
 * "· default", and a second copy of its detail would just be the same panel twice.
 *
 * Two rules keep the offered set and the pinned default coherent, enforced here and re-enforced on the
 * read path (`narrowPersonaSelection`) so a hand-crafted PATCH can't break them:
 *   - at least one persona is always offered — the last ticked box can't be un-ticked, and
 *     "Deselect all" falls back to the pinned default alone;
 *   - the pinned default is always one of the offered ones — un-ticking it re-pins the first
 *     survivor, and offering exactly one persona makes THAT one the default automatically.
 *
 * Every box ticked is stored as an empty `availableKeys` (the "whole library" shape) rather than the
 * full key list, so a questionnaire that offers everything keeps offering everything if the built-in
 * library ever grows.
 *
 * Owns no CONFIG state: the parent holds `personaSelection` and passes the setter, exactly like the
 * tone block, so the single "Save configuration" PATCH sends it. Its one piece of local state is
 * which persona's detail is expanded, which is presentation only and never saved. `personas` is
 * passed in for the tick-boxes, the dropdown and the detail panes, and is never mutated here.
 */

import { useState } from 'react';
import { Drama } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { TONE_DIMENSION_META } from '@/components/admin/questionnaires/tone-dimensions';
import {
  DEFAULT_PERSONA_KEY,
  PERSONA_CATEGORIES,
  PERSONA_CATEGORY_LABELS,
  toDisplayLevel,
} from '@/lib/app/questionnaire/types';
import type {
  PersonaCategory,
  PersonaOption,
  PersonaSelectionSettings,
  PersonaSwitcher,
} from '@/lib/app/questionnaire/types';

/**
 * The persona's active tone dials (enabled dimensions), in the canonical dimension order. `display`
 * is the signed −2…+2 value the tone editor shows (stored 1–5 → display via {@link toDisplayLevel}).
 */
function activeToneDials(persona: PersonaOption): { label: string; display: number }[] {
  return TONE_DIMENSION_META.filter((meta) => persona.tone[meta.key].enabled).map((meta) => ({
    label: meta.label,
    display: toDisplayLevel(persona.tone[meta.key].level),
  }));
}

/**
 * One persona's full detail, revealed under its tick-box on demand: the system-prompt prose that
 * actually drives the interviewer, and the tone dials it applies. Read-only — the library is fixed.
 * The respondent never sees any of this; the one-line description above it is what they read.
 */
function PersonaDetail({ persona }: { persona: PersonaOption }) {
  const dials = activeToneDials(persona);
  return (
    <div className="border-border/70 bg-muted/20 text-muted-foreground ml-6 space-y-2 rounded-md border p-3 text-xs">
      {persona.tone.persona.text.trim() && (
        <div>
          <p className="font-medium">How it is briefed</p>
          <p className="whitespace-pre-line">{persona.tone.persona.text}</p>
        </div>
      )}
      <div>
        <p className="font-medium">
          Tone{' '}
          <FieldHelp title="Persona tone">
            The tone dials this persona applies on top of its prompt — the same nine dimensions as
            this version’s Interviewer tone &amp; persona, on the signed −2…+2 scale (0 = neutral).
            These are fixed per persona; only the dimensions shown are active.
          </FieldHelp>
        </p>
        {dials.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {dials.map((dial) => (
              <span
                key={dial.label}
                className="border-border/70 bg-background text-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
              >
                {dial.label}
                <span className="text-muted-foreground font-medium">
                  {dial.display > 0 ? `+${dial.display}` : dial.display}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <p>Neutral — no tone dials applied.</p>
        )}
      </div>
    </div>
  );
}

export function PersonaLibraryPanel({
  personas,
  selection,
  busy,
  onSelectionChange,
}: {
  /** The fixed built-in persona library — for the dropdown + read-only preview. Never mutated. */
  personas: readonly PersonaOption[];
  selection: PersonaSelectionSettings;
  busy: boolean;
  onSelectionChange: (patch: Partial<PersonaSelectionSettings>) => void;
}) {
  // The one piece of state the panel owns, and it is presentation only: which persona's detail is
  // expanded. An accordion rather than a set, so a long library can't be opened into a wall of text.
  const [openKey, setOpenKey] = useState<string | null>(null);

  // What this questionnaire offers: the admin's ticked subset, or the whole library for the empty
  // "all of them" shape. Kept in library order so the boxes and the dropdown always agree.
  const offered =
    selection.availableKeys.length > 0
      ? personas.filter((p) => selection.availableKeys.includes(p.key))
      : [...personas];
  const offeredKeys = offered.map((p) => p.key);
  const onlyOne = offered.length === 1;

  // The pinned default, clamped to what's offered — `narrowPersonaSelection` clamps identically on
  // the read path, so the panel never shows a default the saved config wouldn't actually use.
  const selectedKey = offered.some((p) => p.key === selection.defaultPersonaKey)
    ? selection.defaultPersonaKey
    : (offered[0]?.key ?? personas[0]?.key ?? DEFAULT_PERSONA_KEY);
  // Show the current default first in the dropdown, then the rest in their canonical order.
  const orderedPersonas = [
    ...offered.filter((p) => p.key === selectedKey),
    ...offered.filter((p) => p.key !== selectedKey),
  ];

  // The tick-boxes are grouped by the situation each voice was written for, so an admin running an
  // HR review doesn't have to read twenty descriptions to find the two that fit. An empty category
  // is skipped, and any persona whose category isn't in the roster still gets a group of its own.
  const grouped: { category: PersonaCategory; members: PersonaOption[] }[] = PERSONA_CATEGORIES.map(
    (category) => ({ category, members: personas.filter((p) => p.category === category) })
  ).filter((group) => group.members.length > 0);

  /**
   * Save a new offered set, holding both invariants: an empty set is refused (something must always
   * be offered), the complete library is normalised back to the empty "all" shape, and the pinned
   * default is re-pinned to the first survivor whenever it's no longer offered — which is what makes
   * a lone offered persona the default without the admin pinning it.
   */
  const setOffered = (keys: readonly string[]) => {
    const next = personas.filter((p) => keys.includes(p.key)).map((p) => p.key);
    if (next.length === 0) return;
    onSelectionChange({
      availableKeys: next.length === personas.length ? [] : next,
      defaultPersonaKey: next.includes(selectedKey) ? selectedKey : (next[0] ?? selectedKey),
    });
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-sm font-medium">
            Interviewers available{' '}
            <FieldHelp title="Available interviewers">
              Tick the built-in interviewers this questionnaire may use. Only these appear to
              respondents, and only one of these can be the default below. At least one must stay
              ticked — tick just one and it becomes the default automatically, with no picker shown
              to respondents (there is nothing to choose between).
            </FieldHelp>
          </Label>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || offered.length === personas.length}
              onClick={() => setOffered(personas.map((p) => p.key))}
            >
              Select all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || onlyOne}
              // Something must always be offered, so "deselect all" leaves the pinned default —
              // which then satisfies the one-offered-persona-is-the-default rule on its own.
              onClick={() => setOffered([selectedKey])}
            >
              Deselect all
            </Button>
          </div>
        </div>
        <div className="space-y-4">
          {grouped.map(({ category, members }) => (
            <div key={category} className="space-y-2">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {PERSONA_CATEGORY_LABELS[category]}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {members.map((p) => {
                  const ticked = offeredKeys.includes(p.key);
                  const name = p.label.trim() || p.key;
                  const open = openKey === p.key;
                  return (
                    <div key={p.key} className="space-y-1">
                      <label
                        htmlFor={`persona-available-${p.key}`}
                        className="text-foreground flex items-start gap-2 text-sm"
                      >
                        <Checkbox
                          id={`persona-available-${p.key}`}
                          checked={ticked}
                          // The last remaining interviewer can't be un-ticked — a questionnaire
                          // with no interviewer has no voice to run with.
                          disabled={busy || (ticked && onlyOne)}
                          onCheckedChange={(checked) =>
                            setOffered(
                              checked
                                ? [...offeredKeys, p.key]
                                : offeredKeys.filter((k) => k !== p.key)
                            )
                          }
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium">{name}</span>
                          {p.key === selectedKey && (
                            <span className="text-muted-foreground"> · default</span>
                          )}
                          {/* The respondent-facing one-liner, verbatim: an admin choosing who to
                              offer should read what the respondent will read. */}
                          {p.description.trim() && (
                            <span className="text-muted-foreground block text-xs">
                              {p.description}
                            </span>
                          )}
                        </span>
                      </label>
                      <button
                        type="button"
                        aria-expanded={open}
                        className="text-muted-foreground hover:text-foreground ml-6 text-xs underline underline-offset-2"
                        onClick={() => setOpenKey(open ? null : p.key)}
                      >
                        {open ? `Hide ${name}` : `More about ${name}`}
                      </button>
                      {open && <PersonaDetail persona={p} />}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          {onlyOne
            ? 'One interviewer available — it is the default, and respondents see no picker.'
            : `${offered.length} of ${personas.length} interviewers available.`}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">
          Default interviewer{' '}
          <FieldHelp title="Default interviewer">
            The available interviewer that governs this questionnaire — its voice replaces this
            version’s custom tone &amp; persona. Everyone gets this persona unless you let
            respondents switch below (then it’s the default, pre-selected on the picker). The
            personas themselves are fixed; to hand-tune a voice, switch to “Custom voice” instead.
          </FieldHelp>
        </Label>
        <Select
          value={selectedKey}
          onValueChange={(v) => onSelectionChange({ defaultPersonaKey: v })}
          disabled={busy || onlyOne}
        >
          <SelectTrigger className="max-w-xs">
            <SelectValue placeholder="Select a persona" />
          </SelectTrigger>
          <SelectContent>
            {orderedPersonas.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {(p.label.trim() || p.key) + (p.key === selectedKey ? ' · Selected' : '')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={selection.allowRespondentSwitch}
            onCheckedChange={(allowRespondentSwitch) =>
              onSelectionChange({ allowRespondentSwitch })
            }
            // Nothing to switch between when only one interviewer is available.
            disabled={busy || onlyOne}
          />
          <Label className="text-sm font-medium">
            Let respondents switch interviewer{' '}
            <FieldHelp title="Respondent-switched persona">
              When on, respondents can change interviewer for their own session — picking any of the
              interviewers ticked above via the switcher below. The default above is the one they
              start on. When off, everyone gets the default and no picker or switcher appears. Needs
              at least two available interviewers.
            </FieldHelp>
          </Label>
        </div>

        {selection.allowRespondentSwitch && !onlyOne && (
          <div className="border-border/60 ml-1 space-y-1.5 border-l pl-4">
            <Label className="text-sm font-medium">
              How respondents switch interviewer{' '}
              <FieldHelp title="Switcher style">
                <strong>Interviewer page</strong> — a pre-chat “Choose your interviewer” step, and
                an Interviewer segment in the in-conversation switcher (today’s behaviour).{' '}
                <strong>Current-interviewer chip</strong> — no pre-chat step; the conversation opens
                on the default persona and an “Interviewer: {'{name}'} · Change” chip opens a modal
                to switch anytime. <strong>Both</strong> — the pre-chat page plus the chip (whose
                Change returns to the page).
              </FieldHelp>
            </Label>
            <Select
              value={selection.switcher}
              onValueChange={(v) => onSelectionChange({ switcher: v as PersonaSwitcher })}
              disabled={busy}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue placeholder="Select a switcher style" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="page">Interviewer page (pre-chat step)</SelectItem>
                <SelectItem value="indicator">Current-interviewer chip (opens a modal)</SelectItem>
                <SelectItem value="both">Both — page + chip</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}

/** Icon for the SettingsGroup (theatre masks — the persona library). Re-exported for the group header. */
export { Drama as PersonaLibraryIcon };
