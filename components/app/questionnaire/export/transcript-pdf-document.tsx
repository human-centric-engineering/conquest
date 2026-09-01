/**
 * Transcript PDF document — the React-PDF layout for a session's conversation (F7.6).
 *
 * A server-rendered `@react-pdf/renderer` document (NOT a DOM/client component — it's
 * passed to `renderToBuffer` in the route's render helper, never mounted in the browser).
 * Renders the {@link TranscriptExportModel}: a branded intro that explains the
 * questionnaire context + run details, then the conversation — each turn labelled
 * ("Interviewer" / the respondent) and timestamped.
 *
 * Sectioned interviews (P21): a section heading is drawn wherever `withSectionHeadings` says one
 * falls — the same rule the plain-text serialiser reads, so a download taken in either format
 * divides the conversation identically. A turn with no section label draws no heading, so every
 * unsectioned session renders exactly as it did before.
 *
 * Sibling to the F7.4 {@link SessionPdfDocument} (the *answers* export): same branding
 * (accent rule + pre-fetched logo data URI), different body — the verbatim conversation
 * instead of captured slot values. A null logo simply renders no image.
 *
 * `// DEMO-ONLY (F7.6):` questionnaire-domain shape — a fork strips this module alongside
 * the F7.4 answers export.
 */

import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';

import type { TranscriptExportModel } from '@/lib/app/questionnaire/export/transcript-types';
import { withSectionHeadings } from '@/lib/app/questionnaire/export/transcript-sections';
import {
  formatTranscriptStamp,
  humaniseSessionStatus,
} from '@/lib/app/questionnaire/export/transcript-format';

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
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 2,
  },
  // Full-bleed brand banner: negative margins cancel the page's 48pt padding so the
  // band runs edge-to-edge (top + sides), echoing the live chat surface band. Its own
  // 48pt horizontal padding re-aligns the logo with the body content below.
  banner: {
    marginTop: -48,
    marginHorizontal: -48,
    marginBottom: 18,
    paddingVertical: 18,
    paddingHorizontal: 48,
    alignItems: 'flex-start',
  },
  // The logo's own backdrop, drawn only when it differs from the band (matches the
  // rounded `--app-logo-bg` chip the chat header paints behind the mark).
  logoBackdrop: {
    padding: 8,
    borderRadius: 6,
  },
  bannerLogo: {
    height: 36,
    objectFit: 'contain',
    alignSelf: 'flex-start',
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
    lineHeight: 1.25,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 11,
    color: COLORS.muted,
    marginBottom: 8,
  },
  metaRow: {
    fontSize: 9,
    color: COLORS.muted,
    marginBottom: 2,
  },
  metaLabel: {
    fontFamily: 'Helvetica-Bold',
  },
  intro: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 10,
    marginBottom: 4,
    lineHeight: 1.4,
  },
  turn: {
    marginBottom: 12,
  },
  // Sectioned interviews (P21). A rule above and generous space before it, so a section boundary
  // reads as a division of the conversation rather than as one more turn with a bold label. The
  // first heading carries the same top margin as the rest: it sits below the intro's own rule, and
  // singling it out would make the first section look like part of the header.
  sectionHeading: {
    marginTop: 10,
    marginBottom: 10,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  sectionHeadingText: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  turnHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  speaker: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
  timestamp: {
    fontSize: 8,
    color: COLORS.faint,
  },
  body: {
    fontSize: 10,
    paddingLeft: 10,
    borderLeftWidth: 2,
  },
  empty: {
    fontSize: 10,
    color: COLORS.faint,
    fontFamily: 'Helvetica-Oblique',
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

/** Append a `Label: value` meta row when the value is present. */
function MetaRow({ label, value }: { label: string; value: string | null }) {
  if (!value || value.trim().length === 0) return null;
  return (
    <Text style={styles.metaRow}>
      <Text style={styles.metaLabel}>{`${label}: `}</Text>
      {value}
    </Text>
  );
}

export interface TranscriptPdfDocumentProps {
  model: TranscriptExportModel;
}

/** The full transcript export document. Server-rendered to a buffer by the route. */
export function TranscriptPdfDocument({ model }: TranscriptPdfDocumentProps) {
  const accent = model.theme.accentColor;
  // The chat surface bands the header in `surfaceColor` (falling back to the resolved
  // logo backdrop); mirror that here so a branded logo sits in a full-width banner
  // instead of floating on white. Null when the client sets no brand chrome → the plain
  // logo-on-white header below.
  const bandColor = model.theme.surfaceColor ?? model.theme.logoBackgroundColor;
  const logoBg = model.theme.logoBackgroundColor;
  const bannered = Boolean(bandColor && model.theme.logoUrl);

  return (
    <Document title={`${model.questionnaireTitle} — transcript`}>
      <Page size="A4" style={styles.page}>
        {bannered && model.theme.logoUrl && (
          <View style={[styles.banner, { backgroundColor: bandColor as string }]}>
            {logoBg && logoBg !== bandColor ? (
              <View style={[styles.logoBackdrop, { backgroundColor: logoBg }]}>
                <Image src={model.theme.logoUrl} style={styles.bannerLogo} />
              </View>
            ) : (
              <Image src={model.theme.logoUrl} style={styles.bannerLogo} />
            )}
          </View>
        )}

        <View style={[styles.header, { borderBottomColor: accent }]}>
          {!bannered && model.theme.logoUrl && (
            <Image src={model.theme.logoUrl} style={styles.logo} />
          )}
          <Text style={styles.title}>{model.questionnaireTitle}</Text>
          <Text style={styles.subtitle}>Conversation transcript</Text>

          <MetaRow label="Reference" value={model.refDisplay} />
          <MetaRow label="Version" value={String(model.versionNumber)} />
          <MetaRow label="Goal" value={model.goal} />
          <MetaRow label="Audience" value={model.audienceSummary} />
          <MetaRow
            label="Respondent"
            value={model.anonymous ? 'Anonymous' : model.respondentLabel}
          />
          <MetaRow label="Started" value={formatTranscriptStamp(model.startedAt)} />
          {model.completedAt && (
            <MetaRow label="Completed" value={formatTranscriptStamp(model.completedAt)} />
          )}
          <MetaRow label="Status" value={humaniseSessionStatus(model.status)} />

          <Text style={styles.intro}>
            {`This is a record of your conversation with ${model.questionnaireTitle}. ` +
              `“${model.interviewerLabel}” is the questionnaire assistant; “${model.respondentLabel}” is you. ` +
              'Each turn is timestamped; times are shown in UTC.'}
          </Text>
        </View>

        {model.turns.length === 0 ? (
          <Text style={styles.empty}>No conversation was recorded for this session.</Text>
        ) : (
          withSectionHeadings(model.turns).map(({ turn, heading }, i) => {
            const interviewer = turn.speaker === 'interviewer';
            const label = interviewer ? model.interviewerLabel : model.respondentLabel;
            return (
              // The heading and the line it introduces are one non-breaking unit, so a section never
              // opens at the foot of a page with its first exchange stranded overleaf.
              <View key={i} wrap={false}>
                {heading && (
                  <View style={[styles.sectionHeading, { borderTopColor: accent }]}>
                    <Text style={[styles.sectionHeadingText, { color: accent }]}>{heading}</Text>
                  </View>
                )}
                <View style={styles.turn}>
                  <View style={styles.turnHeader}>
                    <Text style={[styles.speaker, { color: interviewer ? accent : COLORS.text }]}>
                      {label}
                    </Text>
                    <Text style={styles.timestamp}>{formatTranscriptStamp(turn.at)}</Text>
                  </View>
                  <Text
                    style={[
                      styles.body,
                      { borderLeftColor: interviewer ? accent : COLORS.hairline },
                    ]}
                  >
                    {turn.text.trim()}
                  </Text>
                </View>
              </View>
            );
          })
        )}

        <View style={styles.footer} fixed>
          <Text>{`Generated ${formatTranscriptStamp(model.generatedAt)}`}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
