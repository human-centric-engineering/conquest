/**
 * Cohort Report PDF document (report kind `cohort`, F14.6).
 *
 * A server-rendered `@react-pdf/renderer` document (passed to `renderToBuffer`, never mounted in the
 * browser). Renders the flat {@link CohortReportPdfModel}: a brand header (demo-client logo + accent),
 * the summary, each section's heading + text paragraphs + charts (drawn as labelled bars from the
 * shared chart series), then recommendations and actions. Charts reuse the F14.2 `ChartData` shape,
 * so the on-screen and PDF charts are the same series.
 */

import { Document, Page, Text, View, Image, StyleSheet } from '@react-pdf/renderer';

import type {
  CohortReportPdfModel,
  PdfChart,
} from '@/lib/app/questionnaire/cohort-report/pdf-model';

const COLORS = {
  text: '#1a1a1a',
  muted: '#6b7280',
  faint: '#9ca3af',
  hairline: '#e5e7eb',
  bar: '#cbd5e1',
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
  header: { marginBottom: 20, paddingBottom: 16, borderBottomWidth: 2 },
  logo: { height: 30, marginBottom: 12, objectFit: 'contain', alignSelf: 'flex-start' },
  title: { fontSize: 20, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  meta: { fontSize: 9, color: COLORS.muted },
  para: { marginBottom: 6 },
  sectionTitle: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginTop: 16, marginBottom: 6 },
  h2: { fontSize: 12, fontFamily: 'Helvetica-Bold', marginTop: 14, marginBottom: 6 },
  listItem: { marginBottom: 3, paddingLeft: 8 },
  chartBox: {
    marginVertical: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: COLORS.hairline,
    borderRadius: 4,
  },
  chartTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', marginBottom: 6 },
  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  barLabel: { width: 110, fontSize: 8, color: COLORS.muted },
  barTrack: { flex: 1, height: 8, backgroundColor: '#f1f5f9', borderRadius: 2 },
  barValue: { width: 40, fontSize: 8, textAlign: 'right' },
  note: { fontSize: 8, color: COLORS.faint, fontStyle: 'italic' },
});

function ChartBars({ chart, accent }: { chart: PdfChart; accent: string }) {
  if (chart.suppressed) {
    return <Text style={styles.note}>Hidden — too few respondents to chart.</Text>;
  }
  if (chart.empty || chart.bars.length === 0) {
    return <Text style={styles.note}>No data to chart.</Text>;
  }
  const max = Math.max(...chart.bars.map((b) => b.value), chart.isPercent ? 1 : 0);
  return (
    <View>
      {chart.bars.map((b, i) => {
        const frac = max > 0 ? b.value / max : 0;
        const label = chart.isPercent ? `${Math.round(b.value * 100)}%` : `${b.value}`;
        return (
          <View key={i} style={styles.barRow}>
            <Text style={styles.barLabel}>{b.label}</Text>
            <View style={styles.barTrack}>
              <View
                style={{
                  width: `${Math.round(frac * 100)}%`,
                  height: 8,
                  backgroundColor: accent,
                  borderRadius: 2,
                }}
              />
            </View>
            <Text style={styles.barValue}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function CohortReportPdfDocument({ model }: { model: CohortReportPdfModel }) {
  const accent = model.accentColor;
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={[styles.header, { borderBottomColor: accent }]}>
          {model.logoDataUri ? <Image style={styles.logo} src={model.logoDataUri} /> : null}
          <Text style={styles.title}>{model.title}</Text>
          <Text style={styles.meta}>
            {model.roundName} · {model.totalRespondents} respondents
          </Text>
        </View>

        {model.summaryParagraphs.map((p, i) => (
          <Text key={`sum-${i}`} style={styles.para}>
            {p}
          </Text>
        ))}

        {model.sections.map((section, si) => (
          <View key={si} wrap={false}>
            <Text style={[styles.sectionTitle, { color: accent }]}>{section.heading}</Text>
            {section.paragraphs.map((p, pi) => (
              <Text key={pi} style={styles.para}>
                {p}
              </Text>
            ))}
            {section.charts.map((chart, ci) => (
              <View key={ci} style={styles.chartBox}>
                <Text style={styles.chartTitle}>{chart.title}</Text>
                <ChartBars chart={chart} accent={accent} />
              </View>
            ))}
          </View>
        ))}

        {model.recommendations.length > 0 && (
          <View>
            <Text style={styles.h2}>Recommendations</Text>
            {model.recommendations.map((r, i) => (
              <Text key={i} style={styles.listItem}>
                • {r}
              </Text>
            ))}
          </View>
        )}

        {model.actions.length > 0 && (
          <View>
            <Text style={styles.h2}>Actions</Text>
            {model.actions.map((a, i) => (
              <Text key={i} style={styles.listItem}>
                • {a}
              </Text>
            ))}
          </View>
        )}
      </Page>
    </Document>
  );
}
