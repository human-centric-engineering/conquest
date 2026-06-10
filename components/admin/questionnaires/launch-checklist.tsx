'use client';

/**
 * LaunchChecklist (F2.1 surfacing) — a "Review & Launch" affordance for a draft version.
 *
 * The launch endpoint already enforces the F3.1 gate (goal + audience + ≥1 section +
 * ≥1 question + a saved config row); the bare "Launch" button inside the editor only
 * surfaced a failure as a raw error string. This dialog shows the same five criteria as a
 * green/grey checklist computed client-side from the already-fetched graph, and enables
 * Launch only when all pass — so the admin sees *why* a version isn't ready before they
 * click. The button calls the same `versionStatus` route; no new backend.
 *
 * The readiness checks mirror `assertLaunchable` in
 * `app/api/v1/app/questionnaires/[id]/versions/[vid]/status/route.ts` exactly — keep them
 * in sync. The server stays the source of truth (it re-checks on PATCH); this is UX.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Rocket, X } from 'lucide-react';

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
import { API } from '@/lib/api/endpoints';
import { authoringMutate } from '@/components/admin/questionnaires/authoring-mutate';
import type { AudienceShape } from '@/lib/app/questionnaire/types';

export interface LaunchChecklistProps {
  questionnaireId: string;
  versionId: string;
  versionNumber: number;
  goal: string | null;
  audience: AudienceShape | null;
  sectionCount: number;
  questionCount: number;
  /** True once a config row exists for the version (the launch gate's deliberate signal). */
  configSaved: boolean;
  /** When the data-slots feature is on, launch requires the version to have data slots. */
  dataSlotsRequired?: boolean;
  /** True when the version has ≥1 saved data slot (only checked when required). */
  dataSlotsReady?: boolean;
}

/**
 * Mirrors `hasAudience` in the status route: an audience JSON counts only when it carries
 * at least one defined field (the editor may persist an empty `{}`).
 */
function hasAudience(audience: AudienceShape | null): boolean {
  return (
    typeof audience === 'object' &&
    audience !== null &&
    !Array.isArray(audience) &&
    Object.values(audience as Record<string, unknown>).some((v) => v !== undefined && v !== null)
  );
}

function ChecklistRow({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {ok ? (
        <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
      ) : (
        <X className="text-muted-foreground/60 h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>{children}</span>
      <span className="sr-only">{ok ? '(ready)' : '(not ready)'}</span>
    </li>
  );
}

export function LaunchChecklist({
  questionnaireId,
  versionId,
  versionNumber,
  goal,
  audience,
  sectionCount,
  questionCount,
  configSaved,
  dataSlotsRequired = false,
  dataSlotsReady = false,
}: LaunchChecklistProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checks = [
    { ok: Boolean(goal && goal.trim().length > 0), label: 'A goal is set' },
    { ok: hasAudience(audience), label: 'An audience is described' },
    { ok: sectionCount >= 1, label: 'At least one section' },
    { ok: questionCount >= 1, label: 'At least one question' },
    { ok: configSaved, label: 'Configuration saved' },
    // Data Slots feature: only a gate when the flag is on (the server mirrors this).
    ...(dataSlotsRequired ? [{ ok: dataSlotsReady, label: 'Data slots generated' }] : []),
  ];
  const ready = checks.every((c) => c.ok);

  const launch = () => {
    setBusy(true);
    setError(null);
    authoringMutate('PATCH', API.APP.QUESTIONNAIRES.versionStatus(questionnaireId, versionId), {
      status: 'launched',
    })
      .then(() => {
        setOpen(false);
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not launch this version.');
      })
      .finally(() => setBusy(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Rocket className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Review &amp; Launch
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Launch v{versionNumber}</DialogTitle>
          <DialogDescription>
            Launching makes this version available to respondents. Once launched, editing it forks a
            new draft so in-flight sessions stay pinned to what they started.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 py-1">
          {checks.map((c) => (
            <ChecklistRow key={c.label} ok={c.ok}>
              {c.label}
            </ChecklistRow>
          ))}
        </ul>

        {!ready && (
          <p className="text-muted-foreground text-xs">
            Finish the unchecked items above to launch.
          </p>
        )}
        {error && <p className="text-destructive text-sm">{error}</p>}

        <DialogFooter>
          <Button onClick={launch} disabled={!ready || busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />}
            Launch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
