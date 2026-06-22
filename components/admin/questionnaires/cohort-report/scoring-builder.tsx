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
import { Input } from '@/components/ui/input';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { slugifyKey } from '@/lib/app/questionnaire/authoring/key';
import type {
  ScoringSchemaContent,
  ScoringScale,
  ScoringItem,
  ScoringBand,
} from '@/lib/app/questionnaire/scoring';
import type { ScoringMethod } from '@/lib/app/questionnaire/types';

interface AvailableRef {
  key: string;
  label: string;
  source: 'question' | 'dataSlot';
}

export interface ScoringBuilderProps {
  questionnaireId: string;
  versionId: string;
  initial: ScoringSchemaContent;
  questions: Array<{ key: string; prompt: string; type: string }>;
  dataSlots: Array<{ key: string; name: string }>;
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
  const [saving, setSaving] = React.useState(false);
  const [extracting, setExtracting] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const refs: AvailableRef[] = [
    ...questions.map((q) => ({
      key: q.key,
      label: `${q.prompt} (${q.type})`,
      source: 'question' as const,
    })),
    ...dataSlots.map((d) => ({
      key: d.key,
      label: `${d.name} (data slot)`,
      source: 'dataSlot' as const,
    })),
  ];

  function applySchema(s: ScoringSchemaContent) {
    setScales(s.scales);
    setItems(s.items);
    setBands(s.bands);
    setMethod(s.method);
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
        body: { content: { scales, items, bands, method } },
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
          accept=".pdf,.docx,.md,.txt"
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
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {message && <p className="text-sm text-emerald-600 dark:text-emerald-400">{message}</p>}

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
              value={scale.name}
              onChange={(e) => updateScale(i, { name: e.target.value })}
              className="w-48"
            />
            <Input
              placeholder="key"
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
