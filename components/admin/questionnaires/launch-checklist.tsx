'use client';

/**
 * LaunchChecklist (F2.1 surfacing) — the draft version's "Launch readiness" panel.
 *
 * Renders the launch criteria inline as a checklist: a green check against each step that's
 * done, a muted circle against those still outstanding, and a "Configure" link on every row
 * that opens the page where that step is set up (goal / audience / structure / config live in
 * the Structure editor; data slots have their own tab). A "Review & Launch" dialog repeats the
 * same checklist and enables Launch only when every criterion passes — so the admin sees both
 * *what's left* (inline, with a way to fix it) and a final confirm-before-launch gate.
 *
 * The readiness checks mirror `assertLaunchable` in
 * `app/api/v1/app/questionnaires/[id]/versions/[vid]/status/route.ts` exactly — keep them
 * in sync. The server stays the source of truth (it re-checks on PATCH); this is UX. The button
 * calls the same `versionStatus` route; no new backend.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, ChevronRight, Circle, Loader2, Rocket } from 'lucide-react';

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
import { workspaceVersionBase } from '@/lib/app/questionnaire/workspace-nav';
import {
  blocksLaunch,
  launchReadinessChecks,
  type LaunchCheckKey,
  type LaunchCheckSeverity,
} from '@/lib/app/questionnaire/launch/readiness';
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
  /** When the version uses the adaptive strategy, launch requires its question slots to be embedded. */
  embeddingsRequired?: boolean;
  /** True when every question slot is embedded (only checked when required). */
  embeddingsReady?: boolean;
  /** When adaptive data-slot selection is on + the version has data slots, launch requires them embedded. */
  dataSlotEmbeddingsRequired?: boolean;
  /** True when every data slot is embedded (only checked when required). */
  dataSlotEmbeddingsReady?: boolean;
  /** Number of likert questions in the version — the "every scale is labelled" row shows only when ≥1. */
  likertCount?: number;
  /** How many of those likert questions still lack complete per-point labels (launch requires 0). */
  unlabelledLikertCount?: number;
  /** Number of matrix (rating-grid) questions — also gates the "every scale is labelled" row. */
  matrixCount?: number;
  /** How many matrix questions are misconfigured (no rows / unlabelled scale) — launch requires 0. */
  misconfiguredMatrixCount?: number;
  /** True when `conditionalTopics.enabled` — the coherence row shows only for a version that opted in. */
  conditionalTopicsEnabled?: boolean;
  /** How many `error`-severity Conditional Topics findings the version has (launch requires 0). */
  conditionalTopicsErrorCount?: number;
  /**
   * How many `conditional` topics the version has. With conditional topics OFF and this above zero,
   * the checklist raises a warning row — the topics are authored, and every one of them is being
   * asked to every respondent. It never blocks a launch.
   */
  conditionalTopicsConditionalCount?: number;
}

interface LaunchCheck {
  key: LaunchCheckKey;
  ok: boolean;
  label: string;
  severity: LaunchCheckSeverity;
  /** Page that configures this step (opened by the row's "Configure" link). */
  href: string;
}

function ChecklistRow({
  ok,
  label,
  severity,
  href,
}: {
  ok: boolean;
  label: string;
  severity: LaunchCheckSeverity;
  href?: string;
}) {
  // Three states, not two. A failed warning is neither done nor outstanding-work-before-launch: it
  // is something to look at, so it gets its own colour and its own screen-reader word rather than
  // sitting among the muted rows an admin reads as "still to do".
  const warning = !ok && severity === 'warning';
  return (
    <li className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
      ) : warning ? (
        <AlertTriangle
          className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500"
          aria-hidden="true"
        />
      ) : (
        <Circle className="text-muted-foreground/50 h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span
        className={
          ok
            ? 'text-foreground'
            : warning
              ? 'text-amber-700 dark:text-amber-400'
              : 'text-muted-foreground'
        }
      >
        {label}
      </span>
      <span className="sr-only">{ok ? '(ready)' : warning ? '(warning)' : '(not ready)'}</span>
      {href && (
        <Link
          href={href}
          aria-label={`Configure: ${label}`}
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex shrink-0 items-center gap-0.5 text-xs"
        >
          Configure
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      )}
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
  embeddingsRequired = false,
  embeddingsReady = false,
  dataSlotEmbeddingsRequired = false,
  dataSlotEmbeddingsReady = false,
  likertCount = 0,
  unlabelledLikertCount = 0,
  matrixCount = 0,
  misconfiguredMatrixCount = 0,
  conditionalTopicsEnabled = false,
  conditionalTopicsErrorCount = 0,
  conditionalTopicsConditionalCount = 0,
}: LaunchChecklistProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Goal, audience, sections, questions and the config row are all set in the Structure editor;
  // data slots have their own tab; embeddings are generated on the Settings tab (under the
  // selection-strategy picker). Each row links to the page that satisfies it.
  const base = workspaceVersionBase(questionnaireId, versionId);
  const structureHref = `${base}/structure?edit=1`;

  // The shared readiness helper is the single source of the checks; the data-slots row links to
  // its own tab, the embeddings row to Settings, every other row to the structure editor.
  const hrefByKey: Record<LaunchCheckKey, string> = {
    goal: structureHref,
    audience: structureHref,
    sections: structureHref,
    questions: structureHref,
    config: structureHref,
    scaleLabels: structureHref,
    embeddings: `${base}/settings`,
    dataSlots: `${base}/data-slots`,
    dataSlotEmbeddings: `${base}/data-slots`,
    conditionalTopics: `${base}/topics`,
    conditionalTopicsOff: `${base}/topics`,
  };
  const checks: LaunchCheck[] = launchReadinessChecks({
    goal,
    audience,
    sectionCount,
    questionCount,
    likertCount,
    unlabelledLikertCount,
    matrixCount,
    misconfiguredMatrixCount,
    configSaved,
    dataSlotsRequired,
    dataSlotsReady,
    embeddingsRequired,
    embeddingsReady,
    dataSlotEmbeddingsRequired,
    dataSlotEmbeddingsReady,
    conditionalTopicsEnabled,
    conditionalTopicsErrorCount,
    conditionalTopicsConditionalCount,
  }).map((c) => ({
    key: c.key,
    ok: c.ok,
    label: c.label,
    severity: c.severity,
    href: hrefByKey[c.key],
  }));
  // Both counts read blockers only, so a warning never claims a step is outstanding nor disables
  // the Launch button — the server applies the same rule on the PATCH.
  const ready = !checks.some(blocksLaunch);
  const remaining = checks.filter(blocksLaunch).length;
  const warnings = checks.filter((c) => !c.ok && c.severity === 'warning').length;

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          This version is a <span className="text-foreground font-medium">draft</span>.{' '}
          {ready
            ? warnings > 0
              ? 'All steps are complete — read the highlighted note below, then launch when ready.'
              : 'All steps are complete — review and launch when ready.'
            : `Complete the ${remaining} remaining ${remaining === 1 ? 'step' : 'steps'} below before going live.`}
        </p>

        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setError(null);
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" className="shrink-0">
              <Rocket className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Review &amp; Launch
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Launch v{versionNumber}</DialogTitle>
              <DialogDescription>
                Launching makes this version available to respondents. Once launched, editing it
                forks a new draft so in-flight sessions stay pinned to what they started.
              </DialogDescription>
            </DialogHeader>

            <ul className="space-y-2 py-1">
              {checks.map((c) => (
                <ChecklistRow key={c.key} ok={c.ok} label={c.label} severity={c.severity} />
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
      </div>

      {/* The same criteria, inline — each row links to the page that satisfies it so the admin
          can jump straight to whatever's outstanding without opening the dialog. */}
      <ul className="space-y-1.5">
        {checks.map((c) => (
          <ChecklistRow key={c.key} ok={c.ok} label={c.label} severity={c.severity} href={c.href} />
        ))}
      </ul>
    </div>
  );
}
