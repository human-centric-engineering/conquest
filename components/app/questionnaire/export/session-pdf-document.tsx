/**
 * Session PDF document — the React-PDF layout for a completed session (F7.4).
 *
 * A server-rendered `@react-pdf/renderer` document (NOT a DOM/client component — it's
 * passed to `renderToBuffer` in the route's render helper, never mounted in the
 * browser). Renders the {@link SessionExportModel} the pure builder assembled: a branded
 * header, then every section's slots with the captured answer, its provenance/confidence
 * and rationale, and the refinement audit trail. Unanswered slots render "Not answered"
 * so the export is a complete record of the version.
 *
 * Branding: the accent colour and (best-effort, pre-fetched as a data URI by the seam)
 * logo come from the resolved demo-client theme. A null logo simply renders no image.
 *
 * `// DEMO-ONLY (F7.4):` questionnaire-domain shape — a fork strips this module
 * alongside the F7.2 panel.
 */

import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';

import { formatAnswerValue } from '@/components/app/questionnaire/panel/format-answer-value';
import type { PanelSlotView } from '@/lib/app/questionnaire/panel/types';
import type { SessionExportModel } from '@/lib/app/questionnaire/export/types';

const COLORS = {
  text: '#1a1a1a',
  muted: '#6b7280',
  faint: '#9ca3af',
  hairline: '#e5e7eb',
} as const;

const styles = StyleSheet.create({
  page: {
    paddingTop: 48,
    paddingBottom: 56,
    paddingHorizontal: 48,
    fontSize: 10,
    color: COLORS.text,
    fontFamily: 'Helvetica',
    lineHeight: 1.4,
  },
  header: {
    marginBottom: 20,
    paddingBottom: 16,
    borderBottomWidth: 2,
  },
  logo: {
    height: 32,
    marginBottom: 12,
    objectFit: 'contain',
    alignSelf: 'flex-start',
  },
  title: {
    fontSize: 20,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
  },
  metaRow: {
    fontSize: 9,
    color: COLORS.muted,
    marginBottom: 2,
  },
  metaLabel: {
    fontFamily: 'Helvetica-Bold',
  },
  progress: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 6,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    marginTop: 18,
    marginBottom: 8,
  },
  insightsSummary: {
    marginBottom: 8,
    lineHeight: 1.4,
  },
  insightsHeading: {
    fontFamily: 'Helvetica-Bold',
    marginTop: 8,
    marginBottom: 3,
  },
  insightsBody: {
    marginBottom: 4,
    lineHeight: 1.4,
  },
  insightsAction: {
    marginBottom: 2,
    paddingLeft: 8,
  },
  slot: {
    marginBottom: 12,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.hairline,
  },
  prompt: {
    fontFamily: 'Helvetica-Bold',
    marginBottom: 3,
  },
  answer: {
    marginBottom: 3,
  },
  notAnswered: {
    color: COLORS.faint,
    fontFamily: 'Helvetica-Oblique',
    marginBottom: 3,
  },
  answerMeta: {
    fontSize: 8,
    color: COLORS.muted,
    marginBottom: 2,
  },
  rationale: {
    fontSize: 8,
    color: COLORS.muted,
    fontFamily: 'Helvetica-Oblique',
    marginTop: 1,
  },
  historyBlock: {
    marginTop: 4,
    paddingLeft: 8,
  },
  historyHeading: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.faint,
    marginBottom: 1,
  },
  historyEntry: {
    fontSize: 8,
    color: COLORS.faint,
    marginBottom: 1,
  },
  footer: {
    position: 'absolute',
    bottom: 28,
    left: 48,
    right: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 8,
    color: COLORS.faint,
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
    paddingTop: 6,
  },
});

/** Format an ISO timestamp as a readable date, or a dash when absent/unparseable. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** A capitalised, percentage-formatted confidence string, or null when unscored. */
function formatConfidence(confidence: number | null): string | null {
  if (confidence === null) return null;
  return `${Math.round(confidence * 100)}% confidence`;
}

/** Humanise a profile-field key slug (`job_title` → `Job title`) for the header label. */
function humaniseKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One question slot — answered or "Not answered", with provenance/rationale/history. */
function SlotBlock({ slot }: { slot: PanelSlotView }) {
  const confidence = formatConfidence(slot.confidence);
  const metaParts = slot.answered
    ? [slot.provenance, confidence].filter((p): p is string => Boolean(p))
    : [];

  return (
    <View style={styles.slot} wrap={false}>
      <Text style={styles.prompt}>{slot.prompt}</Text>

      {slot.answered ? (
        <Text style={styles.answer}>{formatAnswerValue(slot.value)}</Text>
      ) : (
        <Text style={styles.notAnswered}>Not answered</Text>
      )}

      {metaParts.length > 0 && <Text style={styles.answerMeta}>{metaParts.join(' · ')}</Text>}

      {slot.rationale && <Text style={styles.rationale}>{slot.rationale}</Text>}

      {slot.refinementHistory.length > 0 && (
        <View style={styles.historyBlock}>
          <Text style={styles.historyHeading}>Refinement history</Text>
          {slot.refinementHistory.map((entry, i) => (
            <Text key={i} style={styles.historyEntry}>
              {`${formatAnswerValue(entry.previousValue)} → ${formatAnswerValue(entry.newValue)}`}
              {entry.source ? ` (${entry.source})` : ''}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * The AI report section. For mode 2 it sits above the raw answers (title "Your insights"); for the
 * woven `narrative` mode it is the whole deliverable (title "Your personalised report").
 */
function InsightsSection({
  insights,
  title,
}: {
  insights: NonNullable<SessionExportModel['insights']>;
  title: string;
}) {
  return (
    <View>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.insightsSummary}>{insights.summary}</Text>
      {insights.sections.map((section, i) => (
        <View key={i}>
          <Text style={styles.insightsHeading}>{section.heading}</Text>
          <Text style={styles.insightsBody}>{section.body}</Text>
        </View>
      ))}
      {insights.actions.length > 0 && (
        <View>
          <Text style={styles.insightsHeading}>What you can do next</Text>
          {insights.actions.map((action, i) => (
            <Text key={i} style={styles.insightsAction}>
              {`• ${action}`}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

export interface SessionPdfDocumentProps {
  model: SessionExportModel;
}

/** The full session export document. Server-rendered to a buffer by the route. */
export function SessionPdfDocument({ model }: SessionPdfDocumentProps) {
  const accent = model.theme.accentColor;
  const respondentLabel = model.respondent ? model.respondent.name : 'Anonymous respondent';
  // Narrative mode: the woven report is the whole document — no raw answer listing, no answered-count.
  const narrativeOnly = model.narrativeOnly === true;

  return (
    <Document title={`${model.questionnaireTitle} — ${narrativeOnly ? 'report' : 'responses'}`}>
      <Page size="A4" style={styles.page}>
        <View style={[styles.header, { borderBottomColor: accent }]}>
          {model.theme.logoUrl && <Image src={model.theme.logoUrl} style={styles.logo} />}
          <Text style={styles.title}>{model.questionnaireTitle}</Text>

          <Text style={styles.metaRow}>
            <Text style={styles.metaLabel}>Version </Text>
            {model.versionNumber}
          </Text>
          {model.goal && (
            <Text style={styles.metaRow}>
              <Text style={styles.metaLabel}>Goal: </Text>
              {model.goal}
            </Text>
          )}
          {model.audienceSummary && (
            <Text style={styles.metaRow}>
              <Text style={styles.metaLabel}>Audience: </Text>
              {model.audienceSummary}
            </Text>
          )}
          <Text style={styles.metaRow}>
            <Text style={styles.metaLabel}>Respondent: </Text>
            {respondentLabel}
          </Text>
          {/* Collected profile (F8.3) — only present for a non-anonymous session; the
              model builder forces it to null in anonymous mode. */}
          {model.profile &&
            Object.entries(model.profile).map(([key, value]) => (
              <Text key={key} style={styles.metaRow}>
                <Text style={styles.metaLabel}>{`${humaniseKey(key)}: `}</Text>
                {String(value)}
              </Text>
            ))}
          <Text style={styles.metaRow}>
            <Text style={styles.metaLabel}>Completed: </Text>
            {formatDate(model.completedAt)}
          </Text>

          {!narrativeOnly && (
            <Text style={styles.progress}>
              {`${model.answeredCount} of ${model.totalCount} questions answered`}
            </Text>
          )}
        </View>

        {model.insights && (
          <InsightsSection
            insights={model.insights}
            title={narrativeOnly ? 'Your personalised report' : 'Your insights'}
          />
        )}

        {/* Raw answer record — omitted for the woven narrative deliverable. */}
        {!narrativeOnly &&
          model.sections.map((section) => (
            <View key={section.sectionId}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.slots.map((slot) => (
                <SlotBlock key={slot.slotKey} slot={slot} />
              ))}
            </View>
          ))}

        <View style={styles.footer} fixed>
          <Text>{`Generated ${formatDate(model.generatedAt)}`}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
