'use client';

/**
 * IntroBackgroundField — the respondent intro "about this questionnaire" editor with AI + document
 * authoring helpers (F12.2).
 *
 * A controlled markdown textarea plus a toolbar: **Upload** (extract text from a .pdf/.docx/.md/.txt
 * via the parse route), **Generate with AI** (compose from a brief), and **Refine with AI** (rewrite
 * the current text per an instruction). Each helper just populates the field — nothing persists here;
 * the parent saves the value through its own config / cohort PATCH. Shared by the config editor's
 * Intro card and the cohort override form.
 */

import { useId, useRef, useState } from 'react';
import { Loader2, Sparkles, Upload, Wand2 } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { parseApiResponse } from '@/lib/api/parse-response';
import { API } from '@/lib/api/endpoints';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { INTRO_BACKGROUND_MAX_LENGTH } from '@/lib/app/questionnaire/types';

export interface IntroBackgroundFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  rows?: number;
  placeholder?: string;
  /**
   * The questionnaire + version this field edits. When both are supplied, the Generate popover offers
   * a "use the questionnaire goal and questions" tickbox that grounds the draft in that version's
   * structure. Omit them (e.g. the cohort override, which isn't tied to one version) to hide it.
   */
  questionnaireId?: string;
  versionId?: string;
}

const ACCEPT = '.pdf,.docx,.md,.txt';

export function IntroBackgroundField({
  value,
  onChange,
  disabled = false,
  id,
  rows = 6,
  placeholder,
  questionnaireId,
  versionId,
}: IntroBackgroundFieldProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<null | 'upload' | 'generate' | 'refine'>(null);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState('');
  const [instruction, setInstruction] = useState('');
  const [generateOpen, setGenerateOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  // Grounding is only offered when the parent knows which version to read; default on when offered.
  const canGround = Boolean(questionnaireId && versionId);
  const [useQuestionnaireContext, setUseQuestionnaireContext] = useState(true);
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const groundCheckboxId = `${fieldId}-ground`;
  const anyBusy = busy !== null || disabled;

  /** The generate payload, folding in the version pair only when grounding is offered and ticked. */
  const generatePayload = (): {
    mode: 'generate';
    brief: string;
    questionnaireId?: string;
    versionId?: string;
  } => ({
    mode: 'generate',
    brief: brief.trim(),
    ...(canGround && useQuestionnaireContext ? { questionnaireId, versionId } : {}),
  });

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so re-picking the same file fires `change` again.
    e.target.value = '';
    if (!file) return;
    setBusy('upload');
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(API.APP.QUESTIONNAIRES.introBackgroundParse, {
        method: 'POST',
        body: form,
      });
      const body = await parseApiResponse<{ text: string; truncated: boolean }>(res);
      if (!body.success) throw new Error(body.error.message);
      onChange(body.data.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that document.');
    } finally {
      setBusy(null);
    }
  };

  const runAuthor = async (
    payload:
      | { mode: 'generate'; brief: string; questionnaireId?: string; versionId?: string }
      | { mode: 'refine'; currentText: string; instruction: string },
    which: 'generate' | 'refine'
  ) => {
    setBusy(which);
    setError(null);
    try {
      const data = await apiClient.post<{ background: string }>(
        API.APP.QUESTIONNAIRES.introBackgroundAuthor,
        { body: payload }
      );
      onChange(data.background);
      if (which === 'generate') {
        setBrief('');
        setGenerateOpen(false);
      } else {
        setInstruction('');
        setRefineOpen(false);
      }
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : `Could not ${which} the text.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => void onFilePicked(e)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={anyBusy}
          onClick={() => fileInputRef.current?.click()}
        >
          {busy === 'upload' ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="mr-1 h-3.5 w-3.5" />
          )}
          Upload document
        </Button>

        {/* Generate with AI */}
        <Popover
          open={generateOpen}
          onOpenChange={(next) => {
            if (busy) return;
            setGenerateOpen(next);
            if (!next) setError(null);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={anyBusy}
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" /> Generate with AI
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 space-y-2">
            <div className="space-y-1">
              <Label className="text-xs font-medium">What is this questionnaire about?</Label>
              <p className="text-muted-foreground text-xs">
                Describe the company, team, purpose, and how results will be used. The AI drafts a
                warm intro from it — review before saving.
              </p>
            </div>
            <AutoTextarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && brief.trim() && !anyBusy) {
                  e.preventDefault();
                  void runAuthor(generatePayload(), 'generate');
                }
              }}
              placeholder="e.g. Acme is running this with its engineering teams to understand collaboration. Results shape how we support teams; responses are anonymous."
              className="min-h-24 text-sm"
              disabled={anyBusy}
            />
            {canGround && (
              <label
                htmlFor={groundCheckboxId}
                className="text-muted-foreground flex cursor-pointer items-start gap-2 text-xs"
              >
                <Checkbox
                  id={groundCheckboxId}
                  checked={useQuestionnaireContext}
                  onCheckedChange={setUseQuestionnaireContext}
                  disabled={anyBusy}
                  className="mt-0.5"
                />
                <span>Use the questionnaire goal and questions to help generate the intro</span>
              </label>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                onClick={() => void runAuthor(generatePayload(), 'generate')}
                disabled={anyBusy || !brief.trim()}
              >
                {busy === 'generate' ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-1.5 h-4 w-4" />
                )}
                Generate
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Refine with AI — needs existing text. */}
        <Popover
          open={refineOpen}
          onOpenChange={(next) => {
            if (busy) return;
            setRefineOpen(next);
            if (!next) setError(null);
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={anyBusy || value.trim().length === 0}
            >
              <Wand2 className="mr-1 h-3.5 w-3.5" /> Refine with AI
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 space-y-2">
            <div className="space-y-1">
              <Label className="text-xs font-medium">How should the AI change the text?</Label>
              <p className="text-muted-foreground text-xs">
                It rewrites the current background per your instruction — e.g. shorter, warmer, or
                add a line about confidentiality.
              </p>
            </div>
            <AutoTextarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === 'Enter' &&
                  instruction.trim() &&
                  !anyBusy
                ) {
                  e.preventDefault();
                  void runAuthor(
                    { mode: 'refine', currentText: value, instruction: instruction.trim() },
                    'refine'
                  );
                }
              }}
              placeholder="e.g. Make it shorter and reassure them it's anonymous."
              className="min-h-20 text-sm"
              disabled={anyBusy}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                onClick={() =>
                  void runAuthor(
                    { mode: 'refine', currentText: value, instruction: instruction.trim() },
                    'refine'
                  )
                }
                disabled={anyBusy || !instruction.trim()}
              >
                {busy === 'refine' ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="mr-1.5 h-4 w-4" />
                )}
                Refine
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <Textarea
        id={fieldId}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={INTRO_BACKGROUND_MAX_LENGTH}
        placeholder={placeholder}
        disabled={anyBusy}
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
