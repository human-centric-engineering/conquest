'use client';

/**
 * Persona library panel (F-persona) — the built-in-persona half of the "Interviewer voice" either/or.
 *
 * Rendered inside the merged "Interviewer tone & persona" SettingsGroup in `config-editor.tsx`, only
 * when the admin has picked "Built-in persona" mode (the outer mode toggle owns `personaSelection.enabled`;
 * this panel assumes it's on). The persona library is FIXED ({@link BUILT_IN_PERSONAS}) — a curated set
 * of named voices, not editable config. So this panel owns no persona editing: it lets the admin pin
 * which built-in persona governs the interviewer, optionally lets respondents switch among the library
 * (and how), and previews the pinned persona read-only (name + description + prose + tone dials). An
 * admin who wants a bespoke voice picks "Custom voice" mode and uses the tone block instead.
 *
 * Owns no state of its own: the parent holds `personaSelection` and passes the setter, exactly like
 * the tone block, so the single "Save configuration" PATCH sends it. `personas` is passed in for the
 * dropdown + preview only and is never mutated here.
 */

import { Drama } from 'lucide-react';

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
import { DEFAULT_PERSONA_KEY, toDisplayLevel } from '@/lib/app/questionnaire/types';
import type {
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
  const selectedKey = personas.some((p) => p.key === selection.defaultPersonaKey)
    ? selection.defaultPersonaKey
    : (personas[0]?.key ?? DEFAULT_PERSONA_KEY);
  const selected = personas.find((p) => p.key === selectedKey) ?? personas[0] ?? null;
  // Show the current default first in the dropdown, then the rest in their canonical order.
  const orderedPersonas = [
    ...personas.filter((p) => p.key === selectedKey),
    ...personas.filter((p) => p.key !== selectedKey),
  ];

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">
          Persona{' '}
          <FieldHelp title="Interviewer persona">
            The built-in interviewer that governs this questionnaire — its voice replaces this
            version’s custom tone &amp; persona. Everyone gets this persona unless you let
            respondents switch below (then it’s the default, pre-selected on the picker). The
            personas themselves are fixed; to hand-tune a voice, switch to “Custom voice” instead.
            Also requires the platform persona-selection flag.
          </FieldHelp>
        </Label>
        <Select
          value={selectedKey}
          onValueChange={(v) => onSelectionChange({ defaultPersonaKey: v })}
          disabled={busy}
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
            disabled={busy}
          />
          <Label className="text-sm font-medium">
            Let respondents switch interviewer{' '}
            <FieldHelp title="Respondent-switched persona">
              When on, respondents can change interviewer for their own session — picking any of the
              built-in personas via the switcher below. The persona above becomes the default they
              start on. When off, everyone gets the persona above and no picker or switcher appears.
            </FieldHelp>
          </Label>
        </div>

        {selection.allowRespondentSwitch && (
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

      {selected && (
        <div className="border-border/70 bg-muted/20 space-y-3 rounded-lg border p-4">
          <div>
            <p className="text-muted-foreground text-xs font-medium">Name</p>
            <p className="flex items-center gap-2 text-sm font-medium">
              {selected.label.trim() || selected.key}
              <span className="inline-flex items-center rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-600 dark:text-violet-400">
                Selected
              </span>
            </p>
          </div>
          {selected.description.trim() && (
            <div>
              <p className="text-muted-foreground text-xs font-medium">
                Description (shown to respondent)
              </p>
              <p className="text-sm">{selected.description}</p>
            </div>
          )}
          {selected.tone.persona.text.trim() && (
            <div>
              <p className="text-muted-foreground text-xs font-medium">Persona prompt</p>
              <p className="text-muted-foreground text-sm whitespace-pre-line">
                {selected.tone.persona.text}
              </p>
            </div>
          )}
          <div>
            <p className="text-muted-foreground text-xs font-medium">
              Tone{' '}
              <FieldHelp title="Persona tone">
                The tone dials this persona applies on top of its prompt — the same nine dimensions
                as this version’s Interviewer tone &amp; persona, on the signed −2…+2 scale (0 =
                neutral). These are fixed per persona; only the dimensions shown are active.
              </FieldHelp>
            </p>
            {activeToneDials(selected).length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {activeToneDials(selected).map((dial) => (
                  <span
                    key={dial.label}
                    className="border-border/70 bg-background text-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                  >
                    {dial.label}
                    <span className="text-muted-foreground font-medium">
                      {dial.display > 0 ? `+${dial.display}` : dial.display}
                    </span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Neutral — no tone dials applied.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Icon for the SettingsGroup (theatre masks — the persona library). Re-exported for the group header. */
export { Drama as PersonaLibraryIcon };
