'use client';

/**
 * Config-conflict UI — surfaces the {@link detectConfigConflicts} results in the settings editor.
 *
 * Two presentations of the same data:
 *   - {@link ConfigConflictBanner} — a summary at the top of the settings column: a count + one line
 *     per conflict, each a jump-link to the offending section. Always in view as the admin works.
 *   - {@link SectionConflicts} — the per-section alerts, rendered at the top of each affected
 *     SettingsGroup so the warning sits exactly where the setting is edited.
 *
 * Non-blocking, informational: styling is by severity, no action is forced.
 */

import { AlertTriangle, Info, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  ConfigConflict,
  ConflictSeverity,
} from '@/lib/app/questionnaire/authoring/config-conflicts';

/** Human labels for the section anchors a conflict points at (mirrors the SettingsGroup titles). */
const SECTION_LABELS: Record<string, string> = {
  questions: 'Questions & completion',
  experience: 'Respondent experience',
  reasoning: 'Reasoning stream',
  tone: 'Interviewer tone & persona',
  access: 'Access & invitations',
  safeguarding: 'Answer quality & safeguarding',
  budget: 'Budget & limits',
  'profile-fields': 'Respondent profile fields',
};

const SEVERITY_STYLES: Record<
  ConflictSeverity,
  { chip: string; ring: string; Icon: typeof AlertTriangle; label: string }
> = {
  error: {
    chip: 'text-red-600 dark:text-red-400',
    ring: 'border-red-500/30 bg-red-500/5',
    Icon: TriangleAlert,
    label: 'Conflict',
  },
  warning: {
    chip: 'text-amber-600 dark:text-amber-400',
    ring: 'border-amber-500/30 bg-amber-500/5',
    Icon: AlertTriangle,
    label: 'Heads up',
  },
  info: {
    chip: 'text-sky-600 dark:text-sky-400',
    ring: 'border-sky-500/30 bg-sky-500/5',
    Icon: Info,
    label: 'Note',
  },
};

/** The most severe severity present drives the summary banner's accent. */
function topSeverity(conflicts: ConfigConflict[]): ConflictSeverity {
  if (conflicts.some((c) => c.severity === 'error')) return 'error';
  if (conflicts.some((c) => c.severity === 'warning')) return 'warning';
  return 'info';
}

/**
 * Summary banner at the top of the settings column. Renders nothing when there are no conflicts.
 * Each row jumps to its section via the anchor id the SettingsGroup already exposes.
 */
export function ConfigConflictBanner({ conflicts }: { conflicts: ConfigConflict[] }) {
  if (conflicts.length === 0) return null;
  const accent = SEVERITY_STYLES[topSeverity(conflicts)];
  const AccentIcon = accent.Icon;
  const errorCount = conflicts.filter((c) => c.severity === 'error').length;

  return (
    <div className={cn('rounded-xl border p-4', accent.ring)} role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <AccentIcon className={cn('mt-0.5 h-5 w-5 shrink-0', accent.chip)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-semibold">
            {conflicts.length === 1
              ? '1 setting needs a look'
              : `${conflicts.length} settings need a look`}
            {errorCount > 0 && (
              <span className={cn('ml-1.5 font-medium', SEVERITY_STYLES.error.chip)}>
                · {errorCount} won’t work as set
              </span>
            )}
          </p>
          <ul className="mt-2 space-y-1.5">
            {conflicts.map((c) => {
              const s = SEVERITY_STYLES[c.severity];
              const RowIcon = s.Icon;
              return (
                <li key={c.id} className="flex items-start gap-2 text-xs">
                  <RowIcon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', s.chip)} aria-hidden />
                  <span className="text-muted-foreground">
                    <span className="text-foreground font-medium">{c.title}</span>
                    {SECTION_LABELS[c.sectionId] && (
                      <>
                        {' — '}
                        <a
                          href={`#${c.sectionId}`}
                          className="underline decoration-dotted underline-offset-2 hover:decoration-solid"
                        >
                          {SECTION_LABELS[c.sectionId]}
                        </a>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** One inline alert. */
function ConflictAlert({ conflict }: { conflict: ConfigConflict }) {
  const s = SEVERITY_STYLES[conflict.severity];
  const Icon = s.Icon;
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border p-3', s.ring)}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', s.chip)} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        <p className="text-foreground text-xs font-semibold">{conflict.title}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">{conflict.message}</p>
      </div>
    </div>
  );
}

/** The conflicts for one section, stacked. Renders nothing when the section is clean. */
export function SectionConflicts({ conflicts }: { conflicts: ConfigConflict[] }) {
  if (conflicts.length === 0) return null;
  return (
    <div className="space-y-2">
      {conflicts.map((c) => (
        <ConflictAlert key={c.id} conflict={c} />
      ))}
    </div>
  );
}
