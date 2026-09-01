'use client';

/**
 * PackExportDialog — download a branded Questionnaire Pack (PDF/CSV/Markdown).
 *
 * Lets the admin pick which of the pack's eight sections to include (all ticked by default except
 * "Evaluation findings", "Conditional topics" and "The interviewer", which are opt-in — see their
 * descriptions) and the output format, then
 * triggers the same-origin authenticated download from `GET …/versions/:vid/pack`. Opened from
 * {@link file://./definition-export-menu.tsx}'s "Download pack…" item, the same way that menu
 * already opens {@link file://./import-definition-dialog.tsx}.
 *
 * ## Sub-options, and why they are generic
 *
 * A section may carry nested sub-options, indented under it and disabled while the parent is off,
 * so each reads as a refinement of its section rather than as a section of its own. This started as
 * one hand-rolled case (`setupTechnical`) rendered inline in the map; it is now a `subOptions` array
 * on the descriptor, because the pack's three opt-in appendices each need several and a fourth
 * hand-rolled special case would be the point at which one of them was silently forgotten.
 *
 * Which is not hypothetical: `interviewerPolicy` shipped on `PackInclude` and on the route with no
 * checkbox here at all, so the interviewer section could never be switched on from the UI. The
 * `_noUnreachableSections` guard below is the compile-time answer to that — a new top-level flag
 * fails type-check until it is given a row.
 *
 * The download URL is dynamic (it depends on the checkbox/format state), so unlike the menu's static
 * `<a download>` links, the Download button sets `window.location.href` directly — same-origin GET,
 * auth cookie carries over, `Content-Disposition: attachment` forces the download without navigating
 * away from the page.
 */

import { useState } from 'react';
import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import {
  DEFAULT_PACK_INCLUDE,
  type PackInclude,
} from '@/lib/app/questionnaire/export/build-pack-model';

export interface PackExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  questionnaireId: string;
  versionId: string;
}

type PackFormat = 'pdf' | 'csv' | 'md';

const FORMAT_LABELS: Record<PackFormat, string> = {
  pdf: 'PDF',
  csv: 'CSV',
  md: 'Markdown',
};

/**
 * The flags that refine a section rather than being one. Listed here so {@link SectionKey} is the
 * exact complement — every other `PackInclude` flag is a top-level section and must have a row.
 */
type SubOptionKey = 'setupTechnical';

type SectionKey = Exclude<keyof PackInclude, SubOptionKey>;

interface SubOption {
  key: SubOptionKey;
  label: string;
  description: string;
}

interface SectionOption {
  key: SectionKey;
  label: string;
  description: string;
  /** Refinements of this section, indented under it and inert while it is off. */
  subOptions?: SubOption[];
}

const SECTIONS = [
  {
    key: 'meta',
    label: 'Title, version & goals',
    description: 'Title, version number, goal, and audience.',
  },
  {
    key: 'questions',
    label: 'Questions',
    description: 'The full section-by-section question structure.',
  },
  {
    key: 'dataSlots',
    label: 'Data slots',
    description: 'The semantic data slots and the questions each one covers.',
  },
  {
    key: 'definitions',
    label: 'Definitions',
    description: 'The accepted glossary terms and their definitions.',
  },
  {
    key: 'setup',
    label: 'Experience setup',
    description: 'Every setting that shapes the respondent experience, grouped by area.',
    subOptions: [
      {
        key: 'setupTechnical',
        label: 'Technical & tuning settings',
        description:
          'Also list the numeric tuning, prompt and cost settings behind the experience — useful internally, usually noise in a client-facing pack. Off by default.',
      },
    ],
  },
  {
    key: 'evaluations',
    label: 'Evaluation findings',
    description:
      "The AI judge panel's latest scores and findings for this version, including suggestions not yet reviewed. Off by default — review before sharing externally.",
  },
  {
    key: 'conditionalTopics',
    label: 'Conditional topics',
    description:
      'How this questionnaire routes respondents — which topics everyone gets, which depend on their answers, and the rules that decide — explained in plain language. Off by default.',
  },
  {
    key: 'interviewerPolicy',
    label: 'The interviewer',
    description:
      'How the interviewer is set up — the house rules in force, how the questioning narrows, which questions are put word for word — and the review of that setup. Off by default.',
  },
] as const satisfies readonly SectionOption[];

/**
 * Compile-time proof that every top-level `PackInclude` flag has a checkbox above.
 *
 * `Record<never, never>` is satisfied by `{}`, so this is inert while the list is complete; add a
 * section flag to `PackInclude` without a row here and the exclusion resolves to that key, which
 * makes the empty object literal a type error naming exactly what is missing. Written because
 * `interviewerPolicy` reached production unreachable — the route accepted it, the model built it,
 * and no surface could ask for it.
 */
const _noUnreachableSections: Record<
  Exclude<SectionKey, (typeof SECTIONS)[number]['key']>,
  never
> = {};
void _noUnreachableSections;

/**
 * The same list, widened for rendering.
 *
 * `SECTIONS` is `as const` so the guard above can read its literal key union, and that same
 * narrowing means `subOptions` is absent from the entries that have none. Rendering wants the
 * common shape, where it is simply `undefined`.
 */
const SECTION_ROWS: readonly SectionOption[] = SECTIONS;

export function PackExportDialog({
  open,
  onOpenChange,
  questionnaireId,
  versionId,
}: PackExportDialogProps) {
  const [included, setIncluded] = useState<PackInclude>(DEFAULT_PACK_INCLUDE);
  const [format, setFormat] = useState<PackFormat>('pdf');

  // Only the top-level sections count — a sub-option on its own produces nothing to download.
  const nothingIncluded = SECTION_ROWS.every((section) => !included[section.key]);

  function handleDownload() {
    const url = new URL(
      API.APP.QUESTIONNAIRES.versionPack(questionnaireId, versionId),
      window.location.origin
    );
    url.searchParams.set('format', format);
    for (const section of SECTION_ROWS) {
      url.searchParams.set(section.key, String(included[section.key]));
      // Sent whatever the parent's state is: the route ignores a sub-option whose section is off,
      // so filtering here would only duplicate that rule in a second place.
      for (const sub of section.subOptions ?? []) {
        url.searchParams.set(sub.key, String(included[sub.key]));
      }
    }
    window.location.href = url.toString();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Download questionnaire pack</DialogTitle>
          <DialogDescription>
            A shareable, ConQuest-branded document covering everything about how this questionnaire
            is set up.{' '}
            <FieldHelp title="Questionnaire pack">
              <p>
                Choose which sections to include and a format. PDF is best for sharing or printing;
                CSV opens in a spreadsheet; Markdown is plain text for docs or wikis. Every format
                carries the same content.
              </p>
            </FieldHelp>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {SECTION_ROWS.map((section) => (
            <div key={section.key} className="space-y-2">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`pack-section-${section.key}`}
                  checked={included[section.key]}
                  onCheckedChange={(checked) =>
                    setIncluded((prev) => ({ ...prev, [section.key]: checked === true }))
                  }
                  className="mt-0.5"
                />
                <Label htmlFor={`pack-section-${section.key}`} className="flex-1 font-normal">
                  <span className="font-medium">{section.label}</span>
                  <span className="text-muted-foreground block text-xs">{section.description}</span>
                </Label>
              </div>

              {/* Indented and disabled with the parent, so a sub-option reads as a refinement of
                  the section above it rather than as a section in its own right. Its stored value
                  is left alone while disabled: unticking a section and re-ticking it should give
                  the admin their refinements back, not silently reset them. */}
              {(section.subOptions ?? []).map((sub) => (
                <div key={sub.key} className="ml-6 flex items-start gap-2">
                  <Checkbox
                    id={`pack-section-${sub.key}`}
                    checked={included[sub.key]}
                    disabled={!included[section.key]}
                    onCheckedChange={(checked) =>
                      setIncluded((prev) => ({ ...prev, [sub.key]: checked === true }))
                    }
                    className="mt-0.5"
                  />
                  <Label htmlFor={`pack-section-${sub.key}`} className="flex-1 font-normal">
                    <span className="font-medium">{sub.label}</span>
                    <span className="text-muted-foreground block text-xs">{sub.description}</span>
                  </Label>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pack-format">Format</Label>
          <Select value={format} onValueChange={(v) => setFormat(v as PackFormat)}>
            <SelectTrigger id="pack-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FORMAT_LABELS) as PackFormat[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {FORMAT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {nothingIncluded && (
          <p className="text-destructive text-sm">Pick at least one section to include.</p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleDownload} disabled={nothingIncluded}>
            <Download className="mr-1.5 h-4 w-4" />
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
