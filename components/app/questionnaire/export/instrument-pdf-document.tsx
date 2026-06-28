/**
 * Instrument PDF document — the React-PDF layout for a blank questionnaire (F14.9).
 *
 * A server-rendered `@react-pdf/renderer` document (NOT a DOM/client component — it's passed to
 * `renderToBuffer` in the route's render helper, never mounted in the browser). Renders an
 * {@link InstrumentModel}: a header with the questionnaire's context, then the numbered sections and
 * questions with type/required marker, answer options/scale, and guidelines. The empty form, for
 * review or paper distribution — no respondent answers.
 *
 * Sibling to {@link file://./transcript-pdf-document.tsx}; deliberately brand-free (a design-time
 * artifact, not a respondent-facing one) so it needs no theme/logo resolution.
 */

import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';

import type {
  InstrumentModel,
  InstrumentQuestion,
} from '@/lib/app/questionnaire/export/build-instrument-model';

const COLORS = {
  text: '#1a1a1a',
  muted: '#6b7280',
  faint: '#9ca3af',
  accent: '#2563eb',
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
    marginBottom: 18,
    paddingBottom: 14,
    borderBottomWidth: 2,
    borderBottomColor: COLORS.accent,
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
  section: {
    marginTop: 14,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.accent,
  },
  sectionDescription: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
  },
  question: {
    marginTop: 10,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.hairline,
  },
  prompt: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
  flags: {
    fontSize: 8,
    color: COLORS.faint,
    marginTop: 1,
  },
  constraint: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
  },
  option: {
    fontSize: 9,
    marginTop: 1,
    marginLeft: 8,
  },
  guidance: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
    fontFamily: 'Helvetica-Oblique',
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

/** One question block — prompt, flags, constraint, options, guidance. */
function QuestionBlock({ q }: { q: InstrumentQuestion }) {
  return (
    <View style={styles.question} wrap={false}>
      <Text style={styles.prompt}>{`${q.number}  ${q.prompt}`}</Text>
      <Text style={styles.flags}>{`${q.typeLabel} · ${q.required ? 'required' : 'optional'}`}</Text>
      {q.constraint && <Text style={styles.constraint}>{q.constraint}</Text>}
      {q.options.map((option, i) => (
        <Text key={i} style={styles.option}>{`•  ${option}`}</Text>
      ))}
      {q.guidelines && q.guidelines.trim().length > 0 && (
        <Text style={styles.guidance}>{`Guidance: ${q.guidelines.trim()}`}</Text>
      )}
    </View>
  );
}

export interface InstrumentPdfDocumentProps {
  model: InstrumentModel;
}

/** The full blank-instrument document. Server-rendered to a buffer by the route. */
export function InstrumentPdfDocument({ model }: InstrumentPdfDocumentProps) {
  return (
    <Document title={`${model.title} — questionnaire`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>{model.title}</Text>
          <Text style={styles.subtitle}>Questionnaire (blank form)</Text>

          <MetaRow label="Version" value={String(model.versionNumber)} />
          <MetaRow label="Goal" value={model.goal} />
          <MetaRow label="Audience" value={model.audienceSummary} />
          <MetaRow
            label="Contents"
            value={`${model.sectionCount} section${model.sectionCount === 1 ? '' : 's'}, ${model.questionCount} question${model.questionCount === 1 ? '' : 's'}`}
          />
        </View>

        {model.sections.length === 0 ? (
          <Text style={styles.empty}>This questionnaire has no sections yet.</Text>
        ) : (
          model.sections.map((section, i) => (
            <View key={i}>
              <View style={styles.section} wrap={false}>
                <Text style={styles.sectionTitle}>{`${section.number}. ${section.title}`}</Text>
                {section.description && section.description.trim().length > 0 && (
                  <Text style={styles.sectionDescription}>{section.description.trim()}</Text>
                )}
              </View>
              {section.questions.length === 0 ? (
                <Text style={styles.empty}>(no questions)</Text>
              ) : (
                section.questions.map((q) => <QuestionBlock key={q.key} q={q} />)
              )}
            </View>
          ))
        )}

        <View style={styles.footer} fixed>
          <Text>{`Generated ${model.generatedAt}`}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
