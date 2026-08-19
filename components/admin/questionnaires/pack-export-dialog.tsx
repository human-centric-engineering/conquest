'use client';

/**
 * PackExportDialog — download a branded Questionnaire Pack (PDF/CSV/Markdown).
 *
 * Lets the admin pick which of the pack's seven sections to include (all ticked by default except
 * "Evaluation findings" and "Adaptive scope", which are opt-in — see their descriptions) and the
 * output format, then
 * triggers the same-origin authenticated download from `GET …/versions/:vid/pack`. "Experience
 * setup" carries one nested sub-option — the technical/tuning settings tier — which is indented
 * under its parent and disabled while the parent is off, so it reads as a refinement of that
 * section rather than a seventh section. Opened from
 * {@link file://./definition-export-menu.tsx}'s "Download pack…" item, the same way that menu
 * already opens {@link file://./import-definition-dialog.tsx}.
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

interface SectionOption {
  key:
    'meta' | 'questions' | 'dataSlots' | 'definitions' | 'setup' | 'evaluations' | 'adaptiveScope';
  label: string;
  description: string;
}

/** The one nested sub-option — a refinement of `setup`, not a section of its own. */
const TECHNICAL_SETTINGS_KEY = 'setupTechnical';

const SECTIONS: SectionOption[] = [
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
  },
  {
    key: 'evaluations',
    label: 'Evaluation findings',
    description:
      "The AI judge panel's latest scores and findings for this version, including suggestions not yet reviewed. Off by default — review before sharing externally.",
  },
  {
    key: 'adaptiveScope',
    label: 'Adaptive scope',
    description:
      'How this questionnaire routes respondents — which topics everyone gets, which depend on their answers, and the rules that decide — explained in plain language. Off by default.',
  },
];

export function PackExportDialog({
  open,
  onOpenChange,
  questionnaireId,
  versionId,
}: PackExportDialogProps) {
  const [included, setIncluded] = useState<PackInclude>(DEFAULT_PACK_INCLUDE);
  const [format, setFormat] = useState<PackFormat>('pdf');

  // Only the seven SECTIONS count — `setupTechnical` on its own produces nothing to download.
  const nothingIncluded = SECTIONS.every((section) => !included[section.key]);

  function handleDownload() {
    const url = new URL(
      API.APP.QUESTIONNAIRES.versionPack(questionnaireId, versionId),
      window.location.origin
    );
    url.searchParams.set('format', format);
    for (const section of SECTIONS) {
      url.searchParams.set(section.key, String(included[section.key]));
    }
    url.searchParams.set(TECHNICAL_SETTINGS_KEY, String(included[TECHNICAL_SETTINGS_KEY]));
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
          {SECTIONS.map((section) => (
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

              {section.key === 'setup' && (
                <div className="ml-6 flex items-start gap-2">
                  <Checkbox
                    id={`pack-section-${TECHNICAL_SETTINGS_KEY}`}
                    checked={included[TECHNICAL_SETTINGS_KEY]}
                    disabled={!included.setup}
                    onCheckedChange={(checked) =>
                      setIncluded((prev) => ({
                        ...prev,
                        [TECHNICAL_SETTINGS_KEY]: checked === true,
                      }))
                    }
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor={`pack-section-${TECHNICAL_SETTINGS_KEY}`}
                    className="flex-1 font-normal"
                  >
                    <span className="font-medium">Technical &amp; tuning settings</span>
                    <span className="text-muted-foreground block text-xs">
                      Also list the numeric tuning, prompt and cost settings behind the experience —
                      useful internally, usually noise in a client-facing pack. Off by default.
                    </span>
                  </Label>
                </div>
              )}
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
