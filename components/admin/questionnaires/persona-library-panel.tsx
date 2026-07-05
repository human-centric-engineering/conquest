'use client';

/**
 * Persona library panel (F-persona) — the admin editor for selectable interviewer personas.
 *
 * Rendered inside the "Interviewer personas" SettingsGroup in `config-editor.tsx`. Owns no state of
 * its own: the parent holds `personas` + `personaSelection` and passes setters, exactly like the tone
 * block, so the single "Save configuration" PATCH sends everything. Each persona is a name +
 * respondent-facing description + persona prose + the same nine tone sliders as the version tone
 * (reused via `ToneDimensionRow`); a chosen persona's whole tone block replaces the version tone for
 * a respondent's session at turn time.
 */

import type { Dispatch, SetStateAction } from 'react';
import { Drama, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import {
  TONE_DIMENSION_META,
  ToneDimensionRow,
} from '@/components/admin/questionnaires/tone-dimensions';
import {
  DEFAULT_PERSONA_KEY,
  DEFAULT_TONE_SETTINGS,
  PERSONA_DESCRIPTION_MAX_LENGTH,
  PERSONA_LABEL_MAX_LENGTH,
  TONE_PERSONA_MAX_LENGTH,
  type PersonaOption,
  type PersonaSelectionSettings,
  type ToneDimension,
  type ToneDimensionKey,
} from '@/lib/app/questionnaire/types';

/** Next free `custom-<n>` key, skipping any already taken (keys are stable once assigned). */
function freshPersonaKey(existing: PersonaOption[]): string {
  const taken = new Set(existing.map((p) => p.key));
  let n = existing.length + 1;
  while (taken.has(`custom-${n}`)) n += 1;
  return `custom-${n}`;
}

/** A blank new persona: neutral tone, empty prose — the admin fills it in. */
function newPersona(existing: PersonaOption[]): PersonaOption {
  return {
    key: freshPersonaKey(existing),
    label: '',
    description: '',
    tone: DEFAULT_TONE_SETTINGS,
  };
}

export function PersonaLibraryPanel({
  personas,
  selection,
  busy,
  onPersonasChange,
  onSelectionChange,
}: {
  personas: PersonaOption[];
  selection: PersonaSelectionSettings;
  busy: boolean;
  onPersonasChange: Dispatch<SetStateAction<PersonaOption[]>>;
  onSelectionChange: (patch: Partial<PersonaSelectionSettings>) => void;
}) {
  const setPersonaField = (index: number, patch: Partial<Omit<PersonaOption, 'tone'>>) =>
    onPersonasChange((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  const setPersonaProse = (index: number, text: string) =>
    onPersonasChange((prev) =>
      prev.map((p, i) =>
        i === index
          ? { ...p, tone: { ...p.tone, persona: { enabled: text.trim().length > 0, text } } }
          : p
      )
    );

  const setPersonaTone = (index: number, key: ToneDimensionKey, patch: Partial<ToneDimension>) =>
    onPersonasChange((prev) =>
      prev.map((p, i) =>
        i === index ? { ...p, tone: { ...p.tone, [key]: { ...p.tone[key], ...patch } } } : p
      )
    );

  const addPersona = () => onPersonasChange((prev) => [...prev, newPersona(prev)]);

  const removePersona = (index: number) => {
    const removedKey = personas[index]?.key;
    onPersonasChange((prev) => prev.filter((_, i) => i !== index));
    // Keep the default coherent: if we removed the default persona, fall back to the first remaining.
    if (removedKey && selection.defaultPersonaKey === removedKey) {
      const fallback = personas.find((_, i) => i !== index);
      onSelectionChange({ defaultPersonaKey: fallback?.key ?? DEFAULT_PERSONA_KEY });
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Switch
            checked={selection.enabled}
            onCheckedChange={(enabled) => onSelectionChange({ enabled })}
            disabled={busy}
          />
          <Label className="text-sm font-medium">
            Let respondents choose their interviewer{' '}
            <FieldHelp title="Respondent-selected persona">
              When on, respondents pick one of the personas below — on a “Choose your interviewer”
              step before the conversation, and via a switcher during it. The chosen persona’s voice
              replaces this version’s tone &amp; persona for that respondent’s session. When off,
              the personas are ignored and your tone &amp; persona settings apply as usual. Also
              requires the platform persona-selection flag.
            </FieldHelp>
          </Label>
        </div>
      </div>

      {selection.enabled && (
        <>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              Default persona{' '}
              <FieldHelp title="Default persona">
                The interviewer a respondent gets if they don’t choose one — and the option
                pre-selected on the picker.
              </FieldHelp>
            </Label>
            <Select
              value={selection.defaultPersonaKey}
              onValueChange={(v) => onSelectionChange({ defaultPersonaKey: v })}
              disabled={busy}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue placeholder="Select a default persona" />
              </SelectTrigger>
              <SelectContent>
                {personas.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label.trim() || p.key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {personas.length < 2 && (
              <p className="text-muted-foreground text-xs">
                Add at least two personas so respondents have a meaningful choice.
              </p>
            )}
          </div>

          <div className="space-y-4">
            {personas.map((persona, index) => (
              <div
                key={persona.key}
                className="border-border/70 bg-muted/20 space-y-3 rounded-lg border p-4"
              >
                <div className="flex items-start gap-2">
                  <div className="grid flex-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs font-medium">Name</Label>
                      <Input
                        value={persona.label}
                        onChange={(e) => setPersonaField(index, { label: e.target.value })}
                        maxLength={PERSONA_LABEL_MAX_LENGTH}
                        disabled={busy}
                        placeholder="e.g. The Coach"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-medium">
                        Description (shown to respondent)
                      </Label>
                      <Input
                        value={persona.description}
                        onChange={(e) => setPersonaField(index, { description: e.target.value })}
                        maxLength={PERSONA_DESCRIPTION_MAX_LENGTH}
                        disabled={busy}
                        placeholder="e.g. Calm, objective and balanced."
                      />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removePersona(index)}
                    disabled={busy}
                    aria-label={`Remove ${persona.label.trim() || 'persona'}`}
                    className="text-muted-foreground hover:text-destructive mt-5 shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs font-medium">
                    Persona prompt{' '}
                    <FieldHelp title="Persona prompt">
                      Cast the interviewer in this character — it speaks from that perspective. Free
                      text, a sentence or two. Leave blank to define the persona through the tone
                      sliders alone.
                    </FieldHelp>
                  </Label>
                  <Textarea
                    value={persona.tone.persona.text}
                    onChange={(e) => setPersonaProse(index, e.target.value)}
                    maxLength={TONE_PERSONA_MAX_LENGTH}
                    rows={2}
                    disabled={busy}
                    placeholder="e.g. You are a warm stand-up comedian at heart, keeping things light."
                  />
                </div>

                <details className="group">
                  <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
                    Tone dials
                  </summary>
                  <div className="mt-3 space-y-3">
                    {TONE_DIMENSION_META.map((meta) => (
                      <ToneDimensionRow
                        key={meta.key}
                        meta={meta}
                        value={persona.tone[meta.key]}
                        busy={busy}
                        onToggle={(enabled) => setPersonaTone(index, meta.key, { enabled })}
                        onLevel={(level) => setPersonaTone(index, meta.key, { level })}
                      />
                    ))}
                  </div>
                </details>
              </div>
            ))}
          </div>

          <Button type="button" variant="outline" size="sm" onClick={addPersona} disabled={busy}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add persona
          </Button>
        </>
      )}
    </div>
  );
}

/** Icon for the SettingsGroup (theatre masks — the persona library). Re-exported for the group header. */
export { Drama as PersonaLibraryIcon };
