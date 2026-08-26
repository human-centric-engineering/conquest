'use client';

/**
 * ScoringBuilder — the visual builder for a version's deterministic scoring schema (F14.4).
 *
 * Edits scales, item→scale mappings (weight + reverse), band cutoffs, and the combine method, then
 * PUTs the whole schema. The same schema model also accepts the upload-extract proposal (the
 * Extract button parses a document and pre-fills the builder for review). Mirrors the form-state +
 * `apiClient` pattern of the other admin panels.
 */

import * as React from 'react';
import { Plus, Trash2, Loader2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { slugifyKey } from '@/lib/app/questionnaire/authoring/key';
import { PARSEABLE_ACCEPT_ATTR } from '@/lib/app/questionnaire/constants';
import type {
  ScoringSchemaContent,
  ScoringScale,
  ScoringItem,
  ScoringBand,
} from '@/lib/app/questionnaire/scoring';
import type { ScoringMethod } from '@/lib/app/questionnaire/types';

/** The numeric range behind a key, or null when it has none (free text, a data slot, an open numeric). */
interface RefBounds {
  min: number;
  max: number;
}

interface AvailableRef {
  key: string;
  label: string;
  source: 'question' | 'dataSlot';
  bounds: RefBounds | null;
}

export interface ScoringBuilderProps {
  questionnaireId: string;
  versionId: string;
  initial: ScoringSchemaContent;
  questions: Array<{ key: string; prompt: string; type: string; bounds: RefBounds | null }>;
  dataSlots: Array<{ key: string; name: string }>;
}

/**
 * What is wrong with the ruler this schema is built on — the C8 warnings, computed from the real
 * bounds behind each key.
 *
 * Two failures, both silent without this. A scale combining a 1–6 item with a 1–5 one is arithmetic
 * over two rulers: it produces a number, and nothing about the number says it is meaningless. And an
 * item whose key has no numeric range at all cannot be put on a common ruler, so turning
 * normalisation on drops it from the scale entirely. Neither is an error — an author may know
 * exactly what they are doing — so both are stated, not enforced.
 */
function rulerWarnings(
  items: ScoringItem[],
  scales: ScoringScale[],
  boundsByRef: Map<string, RefBounds | null>,
  normalise: boolean
): string[] {
  const out: string[] = [];
  const nameFor = (key: string) => scales.find((s) => s.key === key)?.name || key;

  for (const scale of scales) {
    const mine = items.filter((i) => i.scaleKey === scale.key);
    if (mine.length === 0) continue;

    const rulers = new Set(
      mine
        .map((i) => boundsByRef.get(i.ref))
        .filter((b): b is RefBounds => !!b)
        .map((b) => `${b.min}–${b.max}`)
    );
    if (rulers.size > 1 && !normalise) {
      out.push(
        `“${nameFor(scale.key)}” combines items measured on different ranges ` +
          `(${[...rulers].join(', ')}). Their values are not comparable as written — turn on ` +
          `“Put items on a common ruler” to score them together.`
      );
    }

    const unbounded = mine.filter((i) => !boundsByRef.get(i.ref)).map((i) => i.ref);
    if (unbounded.length > 0 && normalise) {
      out.push(
        `“${nameFor(scale.key)}” has ${unbounded.length} item(s) with no numeric range ` +
          `(${unbounded.join(', ')}). With a common ruler on, they cannot be placed on it and are ` +
          `left out of the score.`
      );
    }
  }
  return out;
}

export function ScoringBuilder({
  questionnaireId,
  versionId,
  initial,
  questions,
  dataSlots,
}: ScoringBuilderProps) {
  const [scales, setScales] = React.useState<ScoringScale[]>(initial.scales);
  const [items, setItems] = React.useState<ScoringItem[]>(initial.items);
  const [bands, setBands] = React.useState<ScoringBand[]>(initial.bands);
  const [method, setMethod] = React.useState<ScoringMethod>(initial.method);
  const [normalise, setNormalise] = React.useState<boolean>(initial.normalise === true);
  const [saving, setSaving] = React.useState(false);
  const [extracting, setExtracting] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const refs: AvailableRef[] = [
    ...questions.map((q) => ({
      key: q.key,
      label: `${q.prompt} (${q.type}${q.bounds ? ` ${q.bounds.min}–${q.bounds.max}` : ''})`,
      source: 'question' as const,
      bounds: q.bounds,
    })),
    ...dataSlots.map((d) => ({
      key: d.key,
      label: `${d.name} (data slot)`,
      source: 'dataSlot' as const,
      bounds: null,
    })),
  ];
  const boundsByRef = new Map(refs.map((r) => [r.key, r.bounds]));
  const warnings = rulerWarnings(items, scales, boundsByRef, normalise);

  function applySchema(s: ScoringSchemaContent) {
    setScales(s.scales);
    setItems(s.items);
    setBands(s.bands);
    setMethod(s.method);
    setNormalise(s.normalise === true);
  }

  function addScale() {
    setScales((prev) => [...prev, { key: '', name: '', description: '' }]);
  }
  function updateScale(i: number, patch: Partial<ScoringScale>) {
    setScales((prev) =>
      prev.map((s, idx) => {
        if (idx !== i) return s;
        const next = { ...s, ...patch };
        // Auto-derive the key from the name until the admin has typed a key.
        if (patch.name !== undefined && (!s.key || s.key === slugifyKey(s.name))) {
          next.key = slugifyKey(patch.name);
        }
        return next;
      })
    );
  }
  function removeScale(i: number) {
    setScales((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addItem() {
    const scaleKey = scales[0]?.key ?? '';
    setItems((prev) => [
      ...prev,
      { source: 'question', ref: refs[0]?.key ?? '', scaleKey, weight: 1, reverse: false },
    ]);
  }
  function updateItem(i: number, patch: Partial<ScoringItem>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function removeItem(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addBand() {
    setBands((prev) => [...prev, { scaleKey: scales[0]?.key ?? '', min: 0, max: 0, label: '' }]);
  }
  function updateBand(i: number, patch: Partial<ScoringBand>) {
    setBands((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }
  function removeBand(i: number) {
    setBands((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await apiClient.patch(API.APP.QUESTIONNAIRES.scoringSchema(questionnaireId, versionId), {
        body: { content: { scales, items, bands, method, normalise } },
      });
      setMessage('Scoring schema saved. Respondent scores recomputed.');
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to save the scoring schema.');
    } finally {
      setSaving(false);
    }
  }

  async function handleExtract(file: File) {
    setExtracting(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const proposed = await apiClient.post<ScoringSchemaContent>(
        API.APP.QUESTIONNAIRES.scoringSchemaExtract(questionnaireId, versionId),
        { body: form }
      );
      applySchema(proposed);
      setMessage('Extracted a draft schema from the document — review and save.');
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not extract a schema.');
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void handleSave()} disabled={saving} size="sm">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save scoring
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept={PARSEABLE_ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleExtract(f);
            e.target.value = '';
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={extracting}
          onClick={() => fileRef.current?.click()}
        >
          {extracting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Extract from document
        </Button>
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          Combine
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as ScoringMethod)}
            className="border-input bg-background rounded-md border px-2 py-1 text-sm"
          >
            <option value="mean">Mean</option>
            <option value="sum">Sum</option>
          </select>
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={normalise}
            onChange={(e) => setNormalise(e.target.checked)}
            className="border-input h-4 w-4 rounded border"
          />
          Put items on a common ruler
          <FieldHelp title="Common ruler">
            <p>
              Rescales every answer to its position within its own question&apos;s range before the
              items are combined. Turn this on when one scale draws on questions that are not all
              measured the same way.
            </p>
            <p>
              Without it, a 4 out of 5 and a 4 out of 6 count as the same quantity — they are not —
              and a 0–50 numeric question decides the scale on its own.
            </p>
            <p>
              Two things change when it is on. Scores land in 0–1, so band cutoffs must be
              re-authored in that range (saving with the old ones is refused). And an item whose
              question has no numeric range cannot be placed on the ruler, so it is left out of the
              score.
            </p>
          </FieldHelp>
        </label>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}
      {warnings.length > 0 && (
        <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-400">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {/* Scales */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Scales</h3>
          <Button variant="ghost" size="sm" onClick={addScale}>
            <Plus className="h-4 w-4" /> Add scale
          </Button>
        </div>
        {scales.map((scale, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Name (e.g. Openness)"
              aria-label={`Scale ${i + 1} name`}
              value={scale.name}
              onChange={(e) => updateScale(i, { name: e.target.value })}
              className="w-48"
            />
            <Input
              placeholder="key"
              aria-label={`Scale ${i + 1} key`}
              value={scale.key}
              onChange={(e) => updateScale(i, { key: e.target.value })}
              className="w-32 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeScale(i)}
              aria-label="Remove scale"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </section>

      {/* Items */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Item mappings</h3>
          <Button variant="ghost" size="sm" onClick={addItem} disabled={scales.length === 0}>
            <Plus className="h-4 w-4" /> Add item
          </Button>
        </div>
        {items.map((item, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              value={`${item.source}:${item.ref}`}
              aria-label={`Item ${i + 1} source`}
              onChange={(e) => {
                const [source, ref] = e.target.value.split(':');
                updateItem(i, { source: source as 'question' | 'dataSlot', ref });
              }}
              className="border-input bg-background w-72 rounded-md border px-2 py-1 text-sm"
            >
              {refs.map((r) => (
                <option key={`${r.source}:${r.key}`} value={`${r.source}:${r.key}`}>
                  {r.label}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground text-xs">→</span>
            <select
              value={item.scaleKey}
              aria-label={`Item ${i + 1} scale`}
              onChange={(e) => updateItem(i, { scaleKey: e.target.value })}
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
            >
              {scales.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name || s.key}
                </option>
              ))}
            </select>
            <Input
              type="number"
              step="0.1"
              value={item.weight}
              onChange={(e) => updateItem(i, { weight: Number(e.target.value) })}
              className="w-20"
              aria-label="Weight"
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={item.reverse}
                onChange={(e) => updateItem(i, { reverse: e.target.checked })}
              />
              reverse
            </label>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeItem(i)}
              aria-label="Remove item"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </section>

      {/* Bands */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Bands</h3>
          <Button variant="ghost" size="sm" onClick={addBand} disabled={scales.length === 0}>
            <Plus className="h-4 w-4" /> Add band
          </Button>
        </div>
        {bands.map((band, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              value={band.scaleKey}
              onChange={(e) => updateBand(i, { scaleKey: e.target.value })}
              className="border-input bg-background rounded-md border px-2 py-1 text-sm"
            >
              {scales.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name || s.key}
                </option>
              ))}
            </select>
            <Input
              type="number"
              step="0.1"
              value={band.min}
              onChange={(e) => updateBand(i, { min: Number(e.target.value) })}
              className="w-20"
              aria-label="Band min"
            />
            <span className="text-muted-foreground text-xs">–</span>
            <Input
              type="number"
              step="0.1"
              value={band.max}
              onChange={(e) => updateBand(i, { max: Number(e.target.value) })}
              className="w-20"
              aria-label="Band max"
            />
            <Input
              placeholder="Label (e.g. High)"
              aria-label={`Band ${i + 1} label`}
              value={band.label}
              onChange={(e) => updateBand(i, { label: e.target.value })}
              className="w-40"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeBand(i)}
              aria-label="Remove band"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </section>
    </div>
  );
}
