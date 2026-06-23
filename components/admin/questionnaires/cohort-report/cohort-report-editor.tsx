'use client';

/**
 * CohortReportEditor — manual + AI-assisted editing of a generated cohort report (F14.5).
 *
 * Edits the working-head content: summary + ordered sections (rich-text via Tiptap, move up/down,
 * add/delete/duplicate, per-section AI-assist) + recommendations + actions. Saving PATCHes the full
 * content, which appends an `admin` revision (version-controlled). Charts referenced by a section are
 * shown read-only here (the catalog is set at generation); their order follows the section order.
 */

import * as React from 'react';
import { Loader2, Plus, Trash2, ArrowUp, ArrowDown, Copy, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RichTextEditor } from '@/components/admin/questionnaires/cohort-report/rich-text-editor';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type {
  CohortReportContent,
  CohortReportSection,
  RefinedSection,
  CohortReportView,
} from '@/lib/app/questionnaire/cohort-report';

export interface CohortReportEditorProps {
  roundId: string;
  versionId: string;
  content: CohortReportContent;
  onSaved: (view: CohortReportView) => void;
  onCancel: () => void;
}

type EditSection = CohortReportSection & { format: 'html' };

function toHtmlSection(s: CohortReportSection): EditSection {
  return { ...s, format: 'html' };
}

export function CohortReportEditor({
  roundId,
  versionId,
  content,
  onSaved,
  onCancel,
}: CohortReportEditorProps) {
  const [summary, setSummary] = React.useState(content.summary);
  const [sections, setSections] = React.useState<EditSection[]>(
    content.sections.map(toHtmlSection)
  );
  const [recommendations, setRecommendations] = React.useState(content.recommendations.join('\n'));
  const [actions, setActions] = React.useState(content.actions.join('\n'));
  const [saving, setSaving] = React.useState(false);
  const [assisting, setAssisting] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  function patchSection(i: number, patch: Partial<EditSection>) {
    setSections((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function move(i: number, dir: -1 | 1) {
    setSections((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function remove(i: number) {
    setSections((prev) => prev.filter((_, idx) => idx !== i));
  }
  function duplicate(i: number) {
    setSections((prev) => {
      const next = [...prev];
      next.splice(i + 1, 0, { ...prev[i] });
      return next;
    });
  }
  function addSection() {
    setSections((prev) => [
      ...prev,
      { heading: 'New section', body: '', format: 'html', chartIds: [] },
    ]);
  }

  async function aiAssist(i: number) {
    const instruction = window.prompt('How should the AI revise this section?');
    if (!instruction?.trim()) return;
    setAssisting(i);
    setError(null);
    try {
      const refined = await apiClient.post<RefinedSection>(
        API.APP.ROUNDS.cohortReportRefine(roundId),
        { body: { heading: sections[i].heading, body: sections[i].body, instruction } }
      );
      patchSection(i, { heading: refined.heading, body: refined.body, format: 'html' });
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'AI assist failed.');
    } finally {
      setAssisting(null);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    const payload: CohortReportContent = {
      summary,
      sections: sections.map((s) => ({
        heading: s.heading,
        body: s.body,
        format: 'html',
        chartIds: s.chartIds,
      })),
      charts: content.charts,
      recommendations: recommendations
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean),
      actions: actions
        .split('\n')
        .map((a) => a.trim())
        .filter(Boolean),
    };
    try {
      const view = await apiClient.patch<CohortReportView>(API.APP.ROUNDS.cohortReport(roundId), {
        body: { versionId, content: payload },
      });
      onSaved(view);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to save the report.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button onClick={() => void handleSave()} disabled={saving} size="sm">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save edits
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <section className="space-y-1">
        <h4 className="text-sm font-semibold">Summary</h4>
        <RichTextEditor value={summary} onChange={setSummary} />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Sections</h4>
          <Button variant="ghost" size="sm" onClick={addSection}>
            <Plus className="h-4 w-4" /> Add section
          </Button>
        </div>
        {sections.map((section, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Input
                value={section.heading}
                onChange={(e) => patchSection(i, { heading: e.target.value })}
                className="flex-1 font-medium"
                aria-label={`Section ${i + 1} heading`}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => move(i, -1)}
                aria-label="Move up"
                disabled={i === 0}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => move(i, 1)}
                aria-label="Move down"
                disabled={i === sections.length - 1}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void aiAssist(i)}
                aria-label="AI assist"
                disabled={assisting !== null}
              >
                {assisting === i ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => duplicate(i)}
                aria-label="Duplicate"
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove(i)}
                aria-label="Delete section"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <RichTextEditor
              value={section.body}
              onChange={(html) => patchSection(i, { body: html })}
            />
            {section.chartIds.length > 0 && (
              <p className="text-muted-foreground text-xs">Charts: {section.chartIds.join(', ')}</p>
            )}
          </div>
        ))}
      </section>

      <section className="space-y-1">
        <h4 className="text-sm font-semibold">Recommendations</h4>
        <Textarea
          value={recommendations}
          onChange={(e) => setRecommendations(e.target.value)}
          rows={4}
          placeholder="One per line"
        />
      </section>

      <section className="space-y-1">
        <h4 className="text-sm font-semibold">Actions</h4>
        <Textarea
          value={actions}
          onChange={(e) => setActions(e.target.value)}
          rows={4}
          placeholder="One per line"
        />
      </section>
    </div>
  );
}
