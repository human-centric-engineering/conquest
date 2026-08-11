/**
 * Questionnaire Pack PDF document — the branded, shareable export.
 *
 * A server-rendered `@react-pdf/renderer` document (NOT a DOM/client component — passed to
 * `renderToBuffer` by the route's render helper, never mounted in the browser). Sibling to the
 * brand-free {@link file://./instrument-pdf-document.tsx}: same question-block styling, but this one
 * carries the ConQuest wordmark/tagline/website in the header and a closing "About ConQuest" page —
 * it's the external/showcase artifact, not the design-time reviewer copy. Renders whichever of
 * meta / experience-setup / data-slots / questions / definitions / evaluations the model includes
 * (`null` fields are simply skipped). Evaluations render last, right before the closing page — the
 * appendix position.
 *
 * No font is registered — `@react-pdf/renderer` ships Helvetica by default and no other document in
 * this app registers a custom font, so the wordmark is approximated with Helvetica-Bold + the brand
 * two-tone colours rather than the web's Fraunces serif.
 */

import { Document, Page, Text, View, Link, StyleSheet } from '@react-pdf/renderer';

import { PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';
import type { PackModel, PackSetupItem } from '@/lib/app/questionnaire/export/build-pack-model';
import type { InstrumentQuestion } from '@/lib/app/questionnaire/export/build-instrument-model';

const COLORS = {
  text: '#1a1a1a',
  muted: '#6b7280',
  faint: '#9ca3af',
  accent: PACK_BRAND.brandMarigold,
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
  brandRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  brandLockup: {
    fontSize: 15,
    fontFamily: 'Helvetica-Bold',
  },
  brandCon: {
    color: PACK_BRAND.brandInk,
  },
  brandQuest: {
    color: PACK_BRAND.brandMarigold,
  },
  brandTagline: {
    fontSize: 7,
    fontFamily: 'Helvetica-Bold',
    color: PACK_BRAND.brandTaglineColor,
    letterSpacing: 1,
  },
  brandWebsite: {
    fontSize: 8,
    color: COLORS.muted,
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
    color: PACK_BRAND.brandInk,
  },
  sectionDescription: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
  },
  glossaryEntry: {
    marginTop: 6,
  },
  glossaryTerm: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  glossaryDefinition: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 1,
  },
  setupGroup: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.text,
    marginTop: 8,
  },
  setupRow: {
    flexDirection: 'row',
    fontSize: 9,
    marginTop: 3,
  },
  setupLabel: {
    width: 180,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.text,
  },
  setupValue: {
    color: COLORS.muted,
  },
  dataSlot: {
    marginTop: 8,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.hairline,
  },
  dataSlotName: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
  dataSlotMeta: {
    fontSize: 8,
    color: COLORS.faint,
    marginTop: 1,
  },
  dataSlotDescription: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
  },
  dataSlotQuestion: {
    fontSize: 9,
    marginTop: 1,
    marginLeft: 8,
  },
  question: {
    marginTop: 10,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.hairline,
  },
  evaluationIntro: {
    fontSize: 8,
    color: COLORS.faint,
    fontFamily: 'Helvetica-Oblique',
    marginTop: 2,
  },
  evaluationDimension: {
    marginTop: 10,
  },
  evaluationDimensionLabel: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
  evaluationDimensionScore: {
    fontSize: 8,
    color: COLORS.faint,
    marginTop: 1,
  },
  evaluationFinding: {
    marginTop: 6,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.hairline,
  },
  evaluationFindingHeader: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
  },
  evaluationFindingBody: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 1,
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
  closingHeading: {
    fontSize: 15,
    fontFamily: 'Helvetica-Bold',
    color: PACK_BRAND.brandInk,
    marginBottom: 8,
  },
  closingBlurb: {
    fontSize: 10,
    color: COLORS.text,
    lineHeight: 1.5,
  },
  closingLink: {
    fontSize: 10,
    color: PACK_BRAND.brandTaglineColor,
    marginTop: 12,
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

/** The ConQuest wordmark + tagline + website, rendered as the running header on every page. */
/**
 * Bucket the already-ordered setup rows into `[group, rows]` pairs so each settings group gets its
 * own sub-heading. Preserves arrival order — the registry has already sorted by group then by
 * declaration order, so this only has to detect the boundaries.
 */
function groupSetup(items: PackSetupItem[]): [string, PackSetupItem[]][] {
  const groups: [string, PackSetupItem[]][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last[0] === item.group) last[1].push(item);
    else groups.push([item.group, [item]]);
  }
  return groups;
}

function BrandHeader() {
  return (
    <View style={styles.brandRow} fixed>
      <View>
        <Text style={styles.brandLockup}>
          <Text style={styles.brandCon}>Con</Text>
          <Text style={styles.brandQuest}>Quest</Text>
        </Text>
        <Text style={styles.brandTagline}>{PACK_BRAND.tagline.toUpperCase()}</Text>
      </View>
      <Text style={styles.brandWebsite}>{PACK_BRAND.website}</Text>
    </View>
  );
}

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

export interface PackPdfDocumentProps {
  model: PackModel;
}

/** The full Questionnaire Pack document. Server-rendered to a buffer by the route. */
export function PackPdfDocument({ model }: PackPdfDocumentProps) {
  return (
    <Document title={`${model.title} — Questionnaire Pack`}>
      <Page size="A4" style={styles.page}>
        <BrandHeader />

        <View style={styles.header}>
          <Text style={styles.title}>{model.title}</Text>
          <Text style={styles.subtitle}>Questionnaire Pack</Text>
          <MetaRow label="Version" value={String(model.versionNumber)} />
          {model.meta && (
            <>
              <MetaRow label="Goal" value={model.meta.goal} />
              <MetaRow label="Audience" value={model.meta.audienceSummary} />
              <MetaRow
                label="Contents"
                value={`${model.sectionCount} section${model.sectionCount === 1 ? '' : 's'}, ${model.questionCount} question${model.questionCount === 1 ? '' : 's'}`}
              />
            </>
          )}
        </View>

        {model.setup && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Experience setup</Text>
            {groupSetup(model.setup).map(([group, items]) => (
              <View key={group}>
                <Text style={styles.setupGroup}>{group}</Text>
                {items.map((item) => (
                  <View key={item.label} style={styles.setupRow} wrap={false}>
                    <Text style={styles.setupLabel}>{item.label}</Text>
                    <Text style={styles.setupValue}>{item.value}</Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}

        {model.dataSlots && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Data slots</Text>
            {model.dataSlots.length === 0 ? (
              <Text style={styles.empty}>This questionnaire has no data slots yet.</Text>
            ) : (
              model.dataSlots.map((slot) => (
                <View key={slot.key} style={styles.dataSlot} wrap={false}>
                  <Text style={styles.dataSlotName}>{slot.name}</Text>
                  <Text style={styles.dataSlotMeta}>{slot.theme}</Text>
                  <Text style={styles.dataSlotDescription}>{slot.description}</Text>
                  {slot.questions.map((q) => (
                    <Text key={q.key} style={styles.dataSlotQuestion}>{`•  ${q.prompt}`}</Text>
                  ))}
                </View>
              ))
            )}
          </View>
        )}

        {model.glossary && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{model.glossary.heading}</Text>
            {model.glossary.entries.map((entry) => (
              <View key={entry.term} style={styles.glossaryEntry} wrap={false}>
                <Text style={styles.glossaryTerm}>{entry.term}</Text>
                {entry.definitions.map((definition, i) => (
                  <Text key={i} style={styles.glossaryDefinition}>
                    {entry.definitions.length > 1 ? `${i + 1}. ${definition}` : definition}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )}

        {model.sections && (
          <View>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Questions</Text>
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
          </View>
        )}

        {model.evaluations && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Evaluation</Text>
            <Text style={styles.evaluationIntro}>
              AI judge panel — includes findings not yet reviewed; treat as suggestions, not
              conclusions.
            </Text>
            {!model.evaluations.hasRun ? (
              <Text style={styles.empty}>No evaluation has been run for this version yet.</Text>
            ) : (
              model.evaluations.dimensions.map((dim) => (
                <View key={dim.dimension} style={styles.evaluationDimension}>
                  <Text style={styles.evaluationDimensionLabel}>{dim.label}</Text>
                  <Text style={styles.evaluationDimensionScore}>
                    {dim.diagnostic
                      ? `Judge unavailable: ${dim.diagnostic}`
                      : `Score: ${dim.score !== null ? `${Math.round(dim.score * 100)}%` : 'n/a'}`}
                  </Text>
                  {dim.findings.length === 0 ? (
                    <Text style={styles.empty}>No findings raised.</Text>
                  ) : (
                    dim.findings.map((finding, i) => (
                      <View key={i} style={styles.evaluationFinding} wrap={false}>
                        <Text
                          style={styles.evaluationFindingHeader}
                        >{`[${finding.severity} · ${finding.status}]  ${finding.targetLabel} — ${finding.proposedChange}`}</Text>
                        <Text style={styles.evaluationFindingBody}>{finding.rationale}</Text>
                      </View>
                    ))
                  )}
                </View>
              ))
            )}
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text>{`Generated ${model.generatedAt}`}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>

      <Page size="A4" style={styles.page}>
        <BrandHeader />
        <View style={styles.section}>
          <Text style={styles.closingHeading}>{PACK_BRAND.closingHeading}</Text>
          <Text style={styles.closingBlurb}>{PACK_BRAND.closingBlurb}</Text>
          <Link style={styles.closingLink} src={`https://${PACK_BRAND.website}`}>
            {PACK_BRAND.website}
          </Link>
        </View>
        <View style={styles.footer} fixed>
          <Text>{`Generated ${model.generatedAt}`}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
