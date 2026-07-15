/**
 * Shared respondent-report renderers — extracted from `session-complete.tsx` so both the respondent
 * completion screen AND the admin config preview render a report through the exact same components,
 * guaranteeing a previewed report matches what a respondent will see.
 *
 * All pieces are pure/presentational (props in, JSX out — no hooks, no I/O):
 *   - {@link ReportBody} — the report itself (caveat, summary, sections, actions, appendix, research),
 *     in `screen` (theme tokens) or `paper` (dark-on-white A4) variant.
 *   - {@link ReportPaperHeader} / {@link MetaRow} / {@link formatHeaderDate} — the branded A4 masthead.
 *   - {@link ReportDataAppendix} — the optional questionnaire-data appendix (captured info + Q&A recap).
 */

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { formatSessionRef } from '@/lib/app/questionnaire/session-ref';
import { formatAnswerValue } from '@/components/app/questionnaire/panel/format-answer-value';
import {
  partialReportCaveat,
  splitReportParagraphs,
  type RespondentReportContent,
} from '@/lib/app/questionnaire/report/content';
import type { RespondentReportHeader } from '@/lib/app/questionnaire/report/view';
import type { AnswerPanelView, PanelSlotView } from '@/lib/app/questionnaire/panel/types';

/** Restrained fade-and-rise, matched to the intro splash so the run's bookends feel of a piece. */
export const REVEAL =
  'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500';

/** Format an ISO timestamp as a readable date, or null when absent/unparseable (matches the PDF). */
export function formatHeaderDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** One label + value line in the paper masthead's metadata block. */
export function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed text-neutral-500">
      <span className="font-semibold text-neutral-600">{label} </span>
      {children}
    </p>
  );
}

/**
 * The paper masthead for the A4 preview — the on-screen twin of the PDF's branded header: the demo
 * client's logo (when configured), the questionnaire title, the same Version/Ref/Goal/Audience/
 * Respondent/Completed metadata rows, and the accent-coloured rule beneath. Falls back gracefully:
 * no `header` → just the title; no logo → no image (as the PDF does).
 */
export function ReportPaperHeader({
  title,
  header,
}: {
  title?: string;
  header: RespondentReportHeader | null;
}) {
  const completed = formatHeaderDate(header?.completedAt ?? null);
  return (
    <div
      className="mb-7 border-b-2 pb-5"
      style={{ borderBottomColor: header?.accentColor ?? '#e5e7eb' }}
    >
      {header?.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- external brand logo (arbitrary host); not a Next-optimisable asset.
        <img
          src={header.logoUrl}
          alt=""
          className="mb-4 h-8 max-w-[55%] object-contain object-left"
        />
      )}
      {title && (
        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-balance text-neutral-900">
          {title}
        </h1>
      )}
      {header && (
        <div className="space-y-0.5">
          <MetaRow label="Version">{header.versionNumber}</MetaRow>
          {header.ref && <MetaRow label="Ref:">{formatSessionRef(header.ref)}</MetaRow>}
          {header.goal && <MetaRow label="Goal:">{header.goal}</MetaRow>}
          {header.audienceSummary && <MetaRow label="Audience:">{header.audienceSummary}</MetaRow>}
          <MetaRow label="Respondent:">{header.respondentLabel}</MetaRow>
          {completed && <MetaRow label="Completed:">{completed}</MetaRow>}
        </div>
      )}
    </div>
  );
}

/**
 * The report itself — caveat, summary, titled sections, and next actions — shared by the on-screen
 * completion card (`variant="screen"`) and the full-page A4 preview (`variant="paper"`). Only the
 * typographic scale and colour differ between the two: `screen` inherits theme tokens (works on the
 * card in light/dark); `paper` fixes dark-on-white print colours and a larger, more readable scale.
 */
export function ReportBody({
  content,
  formatted,
  completionPct,
  variant = 'screen',
  animate = true,
}: {
  content: RespondentReportContent;
  formatted: boolean;
  completionPct: number | null;
  variant?: 'screen' | 'paper';
  animate?: boolean;
}) {
  const { summary, sections, actions, research, appendix } = content;
  const paper = variant === 'paper';
  // Formatter-produced reports are pre-laid-out — honour their paragraphs verbatim (skip the
  // deterministic sentence re-grouping, which would re-chop deliberate paragraphs).
  const trust = { trustParagraphs: formatted };
  // Deterministic caveat for a report generated from a partially-complete questionnaire.
  const caveat = partialReportCaveat(completionPct);
  // Stagger the report in as it lands so it resolves gracefully out of the preparing state. The paper
  // preview is already-settled content, so it opts out (`animate={false}`) — no re-stagger on open.
  let step = 0;
  const reveal = animate ? REVEAL : '';
  const delay = () =>
    animate
      ? { animationDelay: `${step++ * 80}ms`, animationFillMode: 'both' as const }
      : undefined;

  const bodyText = paper
    ? 'text-[15px] leading-7 whitespace-pre-line text-neutral-700'
    : 'text-muted-foreground text-sm leading-relaxed whitespace-pre-line';
  const heading = paper
    ? 'text-base font-semibold text-neutral-900'
    : 'text-foreground text-sm font-semibold';

  return (
    <div className={cn('text-left', paper ? 'space-y-6' : 'w-full space-y-4')}>
      {caveat && (
        <p
          className={cn(
            'border-l-2 pl-3 italic',
            paper
              ? 'border-neutral-300 text-[13px] leading-relaxed text-neutral-500'
              : 'text-muted-foreground text-xs leading-relaxed'
          )}
          role="note"
        >
          {caveat}
        </p>
      )}
      <div className={cn(paper ? 'space-y-3' : 'space-y-2', reveal)} style={delay()}>
        {splitReportParagraphs(summary, trust).map((paragraph, i) => (
          // `whitespace-pre-line`: a preserved multi-line block (e.g. a bullet run the model wrote as
          // consecutive `- …` lines) keeps its newlines on screen, matching the PDF's <Text>.
          <p
            key={i}
            className={cn(
              'whitespace-pre-line',
              paper
                ? 'text-[15px] leading-7 text-neutral-800'
                : 'text-foreground text-sm leading-relaxed'
            )}
          >
            {paragraph}
          </p>
        ))}
      </div>
      {sections.map((section, i) => (
        <div key={i} className={cn(paper ? 'space-y-2' : 'space-y-1.5', reveal)} style={delay()}>
          <h2 className={heading}>{section.heading}</h2>
          {splitReportParagraphs(section.body, trust).map((paragraph, j) => (
            <p key={j} className={bodyText}>
              {paragraph}
            </p>
          ))}
        </div>
      ))}
      {actions.length > 0 && (
        <div className={cn(paper ? 'space-y-2' : 'space-y-1', reveal)} style={delay()}>
          <h2 className={heading}>What you can do next</h2>
          <ul
            className={cn(
              'list-disc space-y-1 pl-5',
              paper ? 'text-[15px] leading-7 text-neutral-700' : 'text-muted-foreground text-sm'
            )}
          >
            {actions.map((action, i) => (
              <li key={i}>{action}</li>
            ))}
          </ul>
        </div>
      )}
      {appendix && (
        <div
          className={cn(paper ? 'space-y-2' : 'space-y-1.5', reveal)}
          style={delay()}
          data-report-appendix
        >
          <h2 className={heading}>{appendix.heading ?? 'Appendix'}</h2>
          {splitReportParagraphs(appendix.body, trust).map((paragraph, i) => (
            <p key={i} className={bodyText}>
              {paragraph}
            </p>
          ))}
        </div>
      )}
      {research && research.findings.length > 0 && (
        <div
          className={cn(paper ? 'space-y-3' : 'space-y-2', reveal)}
          style={delay()}
          data-research-display={research.display}
        >
          <h2 className={heading}>Research &amp; sources</h2>
          {research.note && <p className={bodyText}>{research.note}</p>}
          {research.display === 'table' ? (
            <div className="overflow-x-auto">
              <table
                className={cn(
                  'w-full border-collapse text-left',
                  paper ? 'text-[13px] text-neutral-700' : 'text-muted-foreground text-xs'
                )}
              >
                <thead>
                  <tr className={cn('border-b', paper ? 'border-neutral-300' : 'border-border')}>
                    <th className="py-1.5 pr-3 font-semibold">Source</th>
                    <th className="py-1.5 font-semibold">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {research.findings.map((finding, i) => (
                    <tr
                      key={i}
                      className={cn('border-b', paper ? 'border-neutral-200' : 'border-border/60')}
                    >
                      <td className="py-1.5 pr-3 align-top">
                        <a
                          href={finding.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            'font-medium underline underline-offset-2',
                            paper ? 'text-neutral-900' : 'text-foreground'
                          )}
                        >
                          {finding.title}
                        </a>
                        {finding.source && (
                          <span className="block text-[11px] opacity-70">{finding.source}</span>
                        )}
                      </td>
                      <td className="py-1.5 align-top">{finding.snippet}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul
              className={cn(
                'list-disc space-y-2 pl-5',
                paper ? 'text-[13px] leading-6 text-neutral-700' : 'text-muted-foreground text-xs'
              )}
            >
              {research.findings.map((finding, i) => (
                <li key={i}>
                  <a
                    href={finding.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      'font-medium underline underline-offset-2',
                      paper ? 'text-neutral-900' : 'text-foreground'
                    )}
                  >
                    {finding.title}
                  </a>
                  {finding.source && <span className="opacity-70"> — {finding.source}</span>}
                  {finding.snippet && <span className="block opacity-90">{finding.snippet}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Render one captured answer for the appendix: prefer the free-text living paraphrase (the
 * respondent-facing restatement) when present, else the formatted value. Falls back to a dash for an
 * empty value so a row never renders blank.
 */
function answerText(slot: PanelSlotView): string {
  if (slot.paraphrase && slot.paraphrase.trim() !== '') return slot.paraphrase;
  const text = formatAnswerValue(slot.value).trim();
  return text === '' ? '—' : text;
}

/**
 * The optional questionnaire-data appendix shown beneath the report (both the on-screen card and the
 * A4 preview) — the on-screen twin of the PDF's "Captured information" + Q&A sections. Driven by the
 * config's `rawIncludes` (via `include`) and sourced from the panel the respondent saw (`captured`):
 * `dataSlots` renders the captured data-slot values, `questions` the question-by-question recap.
 * Data-slot mode suppresses the raw question rows (`captured.sections` is empty), so the Q&A recap
 * only appears for question-mode versions — matching what the respondent actually saw.
 */
export function ReportDataAppendix({
  captured,
  include,
  variant = 'screen',
}: {
  captured: AnswerPanelView | null;
  include: { questions: boolean; dataSlots: boolean };
  variant?: 'screen' | 'paper';
}) {
  const paper = variant === 'paper';
  if (!captured) return null;

  const showQuestions = include.questions && captured.sections.length > 0;
  const dataGroups = include.dataSlots ? (captured.dataSlotGroups ?? []) : [];
  const showDataSlots = dataGroups.length > 0;
  if (!showQuestions && !showDataSlots) return null;

  const heading = paper
    ? 'text-base font-semibold text-neutral-900'
    : 'text-foreground text-sm font-semibold';
  const subheading = paper
    ? 'text-[13px] font-semibold text-neutral-700'
    : 'text-foreground/90 text-xs font-semibold tracking-wide uppercase';
  const label = paper ? 'text-[13px] font-medium text-neutral-800' : 'text-foreground text-sm';
  const valueText = paper
    ? 'text-[13px] leading-6 text-neutral-600'
    : 'text-muted-foreground text-sm leading-relaxed';
  const muted = paper
    ? 'text-[13px] italic text-neutral-400'
    : 'text-muted-foreground text-sm italic';

  return (
    <div className={cn('text-left', paper ? 'mt-8 space-y-6' : 'mt-6 space-y-5 border-t pt-5')}>
      {showDataSlots && (
        <section className={cn(paper ? 'space-y-3' : 'space-y-2.5')}>
          <h2 className={heading}>Captured information</h2>
          {dataGroups.map((group, gi) => (
            <div key={gi} className="space-y-1.5">
              {group.theme.trim() !== '' && <h3 className={subheading}>{group.theme}</h3>}
              <dl className="space-y-1.5">
                {group.slots.map((slot) => (
                  <div key={slot.key} className="space-y-0.5">
                    <dt className={label}>{slot.name}</dt>
                    <dd className={slot.paraphrase ? valueText : muted}>
                      {slot.paraphrase ?? 'Not captured'}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </section>
      )}
      {showQuestions && (
        <section className={cn(paper ? 'space-y-4' : 'space-y-3')}>
          <h2 className={heading}>Your responses</h2>
          {captured.sections.map((section) => (
            <div key={section.sectionId} className="space-y-2">
              <h3 className={subheading}>{section.title}</h3>
              <dl className="space-y-2">
                {section.slots.map((slot) => (
                  <div key={slot.slotKey} className="space-y-0.5">
                    <dt className={label}>{slot.prompt}</dt>
                    <dd className={slot.answered ? valueText : muted}>
                      {slot.answered ? answerText(slot) : 'Not answered'}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
