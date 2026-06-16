'use client';

/**
 * ComposeStudio — the "describe your goal, watch it build" surface (generative
 * authoring).
 *
 * Three phases on one page:
 *   1. brief     — the admin types a plain-English brief (+ optional title) and hits Generate.
 *   2. streaming — POST /compose/stream; sections appear from the `outline` event and each
 *                  section's questions stream in via `section_done`. The structure builds live.
 *   3. ready     — the draft is persisted (the `done` event carries the new ids). The admin can
 *                  conversationally refine it ("make it shorter", "add a section on pricing") — each
 *                  turn POSTs /compose/refine and re-renders the preview — then Open in editor.
 *
 * The SSE consumption mirrors `data-slots-review.tsx` (fetch → reader → parseSseBlock).
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles, ArrowRight, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { parseSseBlock } from '@/lib/api/sse-parser';
import type { ComposeGenEvent } from '@/lib/app/questionnaire/ingestion/compose-events';
import {
  StructurePreview,
  type PreviewSection,
} from '@/components/admin/questionnaires/compose/structure-preview';

type Phase = 'brief' | 'streaming' | 'ready';

interface ComposedIds {
  questionnaireId: string;
  versionId: string;
}

interface RefineTurn {
  id: number;
  instruction: string;
  summary: string;
}

/** Shape of the refine route's response payload. */
interface RefineResponse {
  summary: string;
  sectionCount: number;
  questionCount: number;
  structure: {
    sections: { ordinal: number; title: string; description?: string }[];
    questions: { sectionOrdinal: number; key: string; prompt: string; suggestedType: string }[];
    goal?: string;
  };
}

/** Rebuild a fully-done preview from a flat refined structure (every section settled). */
function structureToPreview(structure: RefineResponse['structure']): PreviewSection[] {
  return structure.sections
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((section) => ({
      ordinal: section.ordinal,
      title: section.title,
      ...(section.description !== undefined ? { description: section.description } : {}),
      status: 'done' as const,
      questions: structure.questions
        .filter((q) => q.sectionOrdinal === section.ordinal)
        .map((q) => ({ key: q.key, prompt: q.prompt, suggestedType: q.suggestedType })),
    }));
}

export function ComposeStudio() {
  const router = useRouter();
  const briefId = useId();
  const titleId = useId();
  const requiredAllId = useId();

  const [phase, setPhase] = useState<Phase>('brief');
  const [brief, setBrief] = useState('');
  const [title, setTitle] = useState('');
  const [requiredAll, setRequiredAll] = useState(true);
  const [sections, setSections] = useState<PreviewSection[]>([]);
  const [goal, setGoal] = useState<string | undefined>(undefined);
  const [ids, setIds] = useState<ComposedIds | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [instruction, setInstruction] = useState('');
  const [refining, setRefining] = useState(false);
  const [chat, setChat] = useState<RefineTurn[]>([]);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const briefRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the refine textarea to fit its content.
  useEffect(() => {
    const el = instructionRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [instruction]);

  // Auto-grow the brief textarea to fit its content.
  useEffect(() => {
    const el = briefRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [brief]);

  const applyEvent = (ev: ComposeGenEvent) => {
    switch (ev.type) {
      case 'outline':
        setGoal(ev.goal);
        setSections(
          ev.sections.map((s) => ({
            ordinal: s.ordinal,
            title: s.title,
            ...(s.description !== undefined ? { description: s.description } : {}),
            status: 'pending' as const,
            questions: [],
          }))
        );
        break;
      case 'section_done':
        setSections((prev) =>
          prev.map((s) =>
            s.ordinal === ev.ordinal
              ? {
                  ...s,
                  status: 'done',
                  questions: ev.questions.map((q) => ({
                    key: q.key,
                    prompt: q.prompt,
                    suggestedType: q.suggestedType,
                  })),
                }
              : s
          )
        );
        break;
      case 'section_error':
        setSections((prev) =>
          prev.map((s) =>
            s.ordinal === ev.ordinal ? { ...s, status: 'error', message: ev.message } : s
          )
        );
        break;
      // 'done' and 'error' are handled in the read loop.
    }
  };

  const generate = async () => {
    if (brief.trim().length === 0) {
      setError('Describe the questionnaire you want to build.');
      return;
    }
    setPhase('streaming');
    setError(null);
    setSections([]);
    setGoal(undefined);
    setChat([]);
    setIds(null);

    try {
      const res = await fetch(API.APP.QUESTIONNAIRES.composeStream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          brief: brief.trim(),
          ...(title.trim().length > 0 ? { title: title.trim() } : {}),
          requiredAll,
        }),
      });

      // A non-2xx (rate limit, flag off, validation) returns the JSON error envelope, not a stream.
      if (!res.ok || !res.body) {
        let message: string | undefined;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          message = body.error?.message;
        } catch {
          // Non-JSON body — fall through.
        }
        setError(message ?? `Generation failed (${res.status}). Try again.`);
        setPhase('brief');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done: ComposedIds | null = null;
      let streamError: string | null = null;

      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (parsed) {
            const ev = parsed.data as unknown as ComposeGenEvent;
            if (ev.type === 'done') {
              done = { questionnaireId: ev.questionnaireId, versionId: ev.versionId };
            } else if (ev.type === 'error') {
              streamError = ev.message;
            } else {
              applyEvent(ev);
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      if (streamError) {
        setError(streamError);
        setPhase('brief');
      } else if (done) {
        setIds(done);
        setPhase('ready');
      } else {
        setError('Generation did not complete. Try again.');
        setPhase('brief');
      }
    } catch {
      setError('Could not compose the questionnaire. Try again.');
      setPhase('brief');
    }
  };

  const refine = async () => {
    if (!ids || instruction.trim().length === 0) return;
    const text = instruction.trim();
    setRefining(true);
    setError(null);
    try {
      const res = await fetch(
        API.APP.QUESTIONNAIRES.composeRefine(ids.questionnaireId, ids.versionId),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ instruction: text }),
        }
      );
      const parsed = await parseApiResponse<RefineResponse>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        return;
      }
      setSections(structureToPreview(parsed.data.structure));
      setGoal(parsed.data.structure.goal ?? goal);
      setChat((prev) => [
        ...prev,
        { id: prev.length, instruction: text, summary: parsed.data.summary },
      ]);
      setInstruction('');
    } catch {
      setError('Could not apply that change. Try again.');
    } finally {
      setRefining(false);
    }
  };

  const openInEditor = () => {
    if (!ids) return;
    router.push(`/admin/questionnaires/${ids.questionnaireId}/v/${ids.versionId}/structure`);
  };

  const streaming = phase === 'streaming';
  const ready = phase === 'ready';

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      {/* Left: brief + refine chat */}
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={briefId} className="flex items-center gap-1">
            Your goal
            <FieldHelp title="Describe your questionnaire">
              <p>
                Describe what you want to learn and from whom — e.g. &ldquo;an onboarding survey to
                gauge B2B SaaS churn risk for new customer-success managers&rdquo;. The composer
                plans sections, then writes questions for each.
              </p>
            </FieldHelp>
          </Label>
          <Textarea
            ref={briefRef}
            id={briefId}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Describe the questionnaire you want to build…"
            rows={6}
            maxLength={5000}
            disabled={streaming}
            className="max-h-96 min-h-36 resize-none overflow-y-auto"
          />
        </div>

        {phase === 'brief' && (
          <div className="space-y-2">
            <Label htmlFor={titleId} className="flex items-center gap-1">
              Title <span className="text-muted-foreground text-xs">(optional)</span>
              <FieldHelp title="Questionnaire title">
                <p>An optional name. Left blank, it&apos;s derived from the inferred goal.</p>
              </FieldHelp>
            </Label>
            <Input
              id={titleId}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Churn-risk onboarding survey"
              maxLength={200}
            />

            <div className="flex items-center gap-2 pt-1">
              <Checkbox id={requiredAllId} checked={requiredAll} onCheckedChange={setRequiredAll} />
              <Label htmlFor={requiredAllId} className="flex items-center gap-1 font-normal">
                Mark all questions as required
                <FieldHelp title="Mark all questions as required">
                  <p>
                    On by default — every composed question is marked required. Turn it off to
                    create them all as optional. You can change any question afterwards in the
                    editor.
                  </p>
                </FieldHelp>
              </Label>
            </div>
          </div>
        )}

        {!ready && (
          <Button onClick={() => void generate()} disabled={streaming} className="w-full">
            {streaming ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Building…
              </>
            ) : (
              <>
                <Sparkles className="mr-1.5 h-4 w-4" />
                Generate
              </>
            )}
          </Button>
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}

        {ready && (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="text-sm font-medium">Refine it</p>
            <p className="text-muted-foreground text-xs">
              Tell the composer what to change. Each change rewrites the draft.
            </p>

            {chat.length > 0 && (
              <ul className="space-y-2">
                {chat.map((turn) => (
                  <li key={turn.id} className="space-y-1 text-sm">
                    <p className="font-medium">&ldquo;{turn.instruction}&rdquo;</p>
                    <p className="text-muted-foreground text-xs">{turn.summary}</p>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex items-end gap-2">
              <Textarea
                ref={instructionRef}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. Make it shorter; add a section on pricing"
                rows={3}
                maxLength={1000}
                disabled={refining}
                className="max-h-64 min-h-24 resize-none overflow-y-auto"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void refine();
                  }
                }}
              />
              <Button
                size="icon"
                onClick={() => void refine()}
                disabled={refining || instruction.trim().length === 0}
                aria-label="Apply change"
              >
                {refining ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>

            <Button onClick={openInEditor} variant="default" className="w-full">
              Open in editor
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Right: live structure preview */}
      <div>
        {sections.length === 0 ? (
          <div className="text-muted-foreground flex h-full min-h-[16rem] items-center justify-center rounded-lg border border-dashed text-sm">
            {streaming ? 'Planning sections…' : 'Your questionnaire will appear here as it builds.'}
          </div>
        ) : (
          <StructurePreview sections={sections} goal={goal} />
        )}
      </div>
    </div>
  );
}
