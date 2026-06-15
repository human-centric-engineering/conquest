'use client';

/**
 * UploadQuestionnaireDialog — the admin trigger for ingesting a *new* questionnaire.
 *
 * Uploads a source document to `POST /api/v1/app/questionnaires`, which extracts
 * its structure and creates a draft questionnaire. Optional admin metadata (goal +
 * audience) overrides what the extractor would otherwise infer — every override
 * field left blank is inferred. On success the dialog routes to the new
 * questionnaire's detail page so the admin lands on the freshly extracted draft.
 *
 * Multipart, so it `fetch`es a `FormData` body directly (the JSON authoring runner
 * doesn't fit). Mirrors the structure of {@link file://./reingest-dialog.tsx} but
 * creates rather than replaces — so no destructive warning, and it captures full
 * metadata up front.
 */

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { StatusTicker } from '@/components/admin/questionnaires/status-ticker';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import {
  AUDIENCE_EXPERTISE_LEVELS,
  AUDIENCE_SENSITIVITY_LEVELS,
} from '@/lib/app/questionnaire/types';
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';

/** Allowed upload extensions — mirrors the server's `ALLOWED_EXTENSIONS`. */
const ACCEPT = '.pdf,.docx,.md,.txt';

/**
 * Sentinel for "let the extractor infer" on the enum selects. Radix Select forbids
 * an empty-string item value, so a non-empty placeholder stands in for "unset";
 * it's never sent to the server (those keys are simply omitted from the FormData).
 */
const INFER = '__infer__';

/** Sentinel for "no demo client" on the attribution select (Radix forbids empty values). */
const NO_CLIENT = '__none__';

interface UploadResult {
  questionnaireId: string;
  versionId: string;
  sectionCount: number;
  questionCount: number;
  changeCount: number;
}

export interface UploadQuestionnaireDialogProps {
  /** Trigger button style — defaults to a primary "Upload questionnaire" button. */
  size?: React.ComponentProps<typeof Button>['size'];
  variant?: React.ComponentProps<typeof Button>['variant'];
  className?: string;
  /**
   * DEMO-ONLY (F2.5.1): active demo clients available to attribute the new
   * questionnaire to. Omitted/empty hides the attribution picker entirely (a fork
   * that strips demo tenancy, or a deployment with no clients yet).
   */
  demoClientOptions?: AttributedDemoClient[];
  /**
   * Controlled open state. When provided (with {@link onOpenChange}), the parent
   * drives the dialog — e.g. opened from a "New questionnaire" dropdown item rather
   * than this component's own trigger button. Omit for the default self-managed mode.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Render the built-in trigger button. Set `false` when a parent supplies its own. */
  showTrigger?: boolean;
}

export function UploadQuestionnaireDialog({
  size = 'default',
  variant = 'default',
  className,
  demoClientOptions = [],
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: UploadQuestionnaireDialogProps) {
  const router = useRouter();
  const fileInputId = useId();
  const nameId = useId();
  const demoClientFieldId = useId();
  const goalId = useId();
  const descriptionId = useId();
  const roleId = useId();
  const expertiseId = useId();
  const durationId = useId();
  const localeId = useId();
  const sensitivityId = useId();
  const notesId = useId();
  const tablesId = useId();
  const fileRef = useRef<HTMLInputElement>(null);

  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (controlledOpen === undefined) setInternalOpen(next);
  };
  const [name, setName] = useState('');
  const [demoClientId, setDemoClientId] = useState<string>(NO_CLIENT);
  const [goal, setGoal] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState('');
  const [expertiseLevel, setExpertiseLevel] = useState<string>(INFER);
  const [duration, setDuration] = useState('');
  const [locale, setLocale] = useState('');
  const [sensitivity, setSensitivity] = useState<string>(INFER);
  const [notes, setNotes] = useState('');
  const [extractTables, setExtractTables] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setDemoClientId(NO_CLIENT);
    setGoal('');
    setDescription('');
    setRole('');
    setExpertiseLevel(INFER);
    setDuration('');
    setLocale('');
    setSensitivity(INFER);
    setNotes('');
    setExtractTables(false);
    setError(null);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a document to upload.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const body = new FormData();
      body.set('file', file);

      // Only send non-empty overrides — the server treats blank/whitespace as
      // "infer this", and unset enum selects must be omitted entirely.
      const setIfPresent = (key: string, value: string) => {
        const trimmed = value.trim();
        if (trimmed.length > 0) body.set(key, trimmed);
      };
      setIfPresent('title', name);
      if (demoClientId !== NO_CLIENT) body.set('demoClientId', demoClientId);
      setIfPresent('goal', goal);
      setIfPresent('audience.description', description);
      setIfPresent('audience.role', role);
      if (expertiseLevel !== INFER) body.set('audience.expertiseLevel', expertiseLevel);
      setIfPresent('audience.estimatedDurationMinutes', duration);
      setIfPresent('audience.locale', locale);
      if (sensitivity !== INFER) body.set('audience.sensitivity', sensitivity);
      setIfPresent('audience.notes', notes);
      if (extractTables) body.set('extractTables', 'true');

      // Multipart — do NOT set Content-Type; the browser adds the boundary.
      const res = await fetch(API.APP.QUESTIONNAIRES.ROOT, {
        method: 'POST',
        credentials: 'same-origin',
        body,
      });
      const parsed = await parseApiResponse<UploadResult>(res);
      if (!parsed.success) {
        setError(parsed.error.message);
        setBusy(false);
        return;
      }
      // Land on the freshly extracted draft. Keep busy=true so the form stays
      // disabled during navigation rather than flashing re-enabled.
      setOpen(false);
      router.push(`/admin/questionnaires/${parsed.data.questionnaireId}`);
    } catch {
      setError('Upload failed. Please try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {showTrigger && (
        <DialogTrigger asChild>
          <Button size={size} variant={variant} className={className}>
            <Upload className="mr-1.5 h-4 w-4" />
            Upload questionnaire
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload questionnaire</DialogTitle>
          <DialogDescription>
            Upload a source document and an agent extracts its sections and questions into a new
            draft. The audience and goal fields below are optional overrides — leave any blank to
            let the extractor infer it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={fileInputId}>
              Source document{' '}
              <FieldHelp title="Source document">
                A <code>.pdf</code>, <code>.docx</code>, <code>.md</code>, or <code>.txt</code> file
                (max 25 MB). The extractor reads it and builds the questionnaire’s sections and
                questions. Re-uploading an identical document is rejected as a duplicate.
              </FieldHelp>
            </Label>
            <Input
              id={fileInputId}
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              disabled={busy}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={nameId}>
              Name{' '}
              <FieldHelp title="Questionnaire name">
                Optional. The name this questionnaire is listed under. Leave blank to use the title
                the extractor reads from the document.
              </FieldHelp>
            </Label>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              placeholder="Leave blank to use the document title"
            />
          </div>

          {/* DEMO-ONLY (F2.5.1): optional attribution. Hidden when there are no active clients. */}
          {demoClientOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor={demoClientFieldId}>
                Demo client{' '}
                <FieldHelp title="Demo-client attribution">
                  Optional. Attribute this questionnaire to a demo client so its respondent surface
                  and invitations wear that brand. “None” is a generic demo. You can change this
                  later from the questionnaire’s Settings tab.
                </FieldHelp>
              </Label>
              <Select value={demoClientId} onValueChange={setDemoClientId} disabled={busy}>
                <SelectTrigger id={demoClientFieldId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CLIENT}>None (generic demo)</SelectItem>
                  {demoClientOptions.map((client) => (
                    <SelectItem key={client.id} value={client.id}>
                      {client.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={goalId}>
              Goal{' '}
              <FieldHelp title="Goal">
                Optional. The questionnaire’s objective. When set, this wins over whatever the
                extractor infers. Leave blank to use the inferred goal.
              </FieldHelp>
            </Label>
            <Textarea
              id={goalId}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={busy}
              rows={2}
              placeholder="Leave blank to use the inferred goal"
            />
          </div>

          <div className="space-y-3 border-t pt-4">
            <p className="text-muted-foreground text-sm font-medium">Audience (optional)</p>

            <div className="space-y-1.5">
              <Label htmlFor={descriptionId}>
                Description{' '}
                <FieldHelp title="Audience description">
                  Who completes this questionnaire — e.g. “new customers onboarding to the
                  platform”. Blank lets the extractor infer the audience.
                </FieldHelp>
              </Label>
              <Textarea
                id={descriptionId}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy}
                rows={2}
                placeholder="Leave blank to infer"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={roleId}>
                  Role{' '}
                  <FieldHelp title="Audience role">
                    The respondent’s role, e.g. “patient”, “job applicant”, “IT administrator”.
                  </FieldHelp>
                </Label>
                <Input
                  id={roleId}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={busy}
                  placeholder="Infer"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={localeId}>
                  Locale{' '}
                  <FieldHelp title="Locale">
                    The language/locale the questionnaire is delivered in, e.g. <code>en-GB</code>.
                  </FieldHelp>
                </Label>
                <Input
                  id={localeId}
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                  disabled={busy}
                  placeholder="Infer"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={expertiseId}>
                  Expertise level{' '}
                  <FieldHelp title="Expertise level">
                    How much domain knowledge the audience has. Steers the conversational tone.
                  </FieldHelp>
                </Label>
                <Select value={expertiseLevel} onValueChange={setExpertiseLevel} disabled={busy}>
                  <SelectTrigger id={expertiseId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INFER}>Infer</SelectItem>
                    {AUDIENCE_EXPERTISE_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={sensitivityId}>
                  Sensitivity{' '}
                  <FieldHelp title="Sensitivity">
                    How sensitive the collected data is. Higher sensitivity tightens guardrails.
                  </FieldHelp>
                </Label>
                <Select value={sensitivity} onValueChange={setSensitivity} disabled={busy}>
                  <SelectTrigger id={sensitivityId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INFER}>Infer</SelectItem>
                    {AUDIENCE_SENSITIVITY_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={durationId}>
                  Est. duration (min){' '}
                  <FieldHelp title="Estimated duration">
                    Roughly how many minutes the questionnaire takes to complete. Shown to
                    respondents and used for pacing.
                  </FieldHelp>
                </Label>
                <Input
                  id={durationId}
                  type="number"
                  min={1}
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  disabled={busy}
                  placeholder="Infer"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={notesId}>
                Notes{' '}
                <FieldHelp title="Audience notes">
                  Any extra context about the audience the extractor and agent should keep in mind.
                </FieldHelp>
              </Label>
              <Textarea
                id={notesId}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={busy}
                rows={2}
                placeholder="Leave blank to infer"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 border-t pt-4 text-sm">
            <Checkbox
              id={tablesId}
              checked={extractTables}
              onCheckedChange={(checked) => setExtractTables(checked === true)}
              disabled={busy}
            />
            <Label htmlFor={tablesId} className="font-normal">
              Extract tables from PDF
            </Label>
            <FieldHelp title="Extract tables from PDF">
              Parse tabular layout in PDFs into text rows before extraction. Slower; only helps when
              the document’s questions live in tables.
            </FieldHelp>
          </div>

          {busy && <StatusTicker />}
          {error && <p className="text-destructive text-sm">{error}</p>}

          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Upload &amp; extract
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
