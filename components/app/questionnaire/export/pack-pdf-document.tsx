/**
 * Questionnaire Pack PDF document — the branded, shareable export.
 *
 * A server-rendered `@react-pdf/renderer` document (NOT a DOM/client component — passed to
 * `renderToBuffer` by the route's render helper, never mounted in the browser). Sibling to the
 * brand-free {@link file://./instrument-pdf-document.tsx}: same question-block styling, but this one
 * carries the ConQuest wordmark/tagline/website in the header and a closing "About ConQuest" page —
 * it's the external/showcase artifact, not the design-time reviewer copy. Renders whichever of
 * meta / experience-setup / data-slots / questions / definitions / evaluations / conditional topics the
 * model includes (`null` fields are simply skipped). Evaluations and conditional topics render last,
 * right before the closing page — the appendix position. The F17.21 scope-evaluation judge panel's
 * verdict renders as the last subsection of conditional topics, after the hard rules — a judgement about
 * the routing design above it, not a section of its own.
 *
 * No font is registered — `@react-pdf/renderer` ships Helvetica by default and no other document in
 * this app registers a custom font, so the wordmark is approximated with Helvetica-Bold + the brand
 * two-tone colours rather than the web's Fraunces serif.
 */

import { Document, Page, Text, View, Link, StyleSheet } from '@react-pdf/renderer';

import { PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';
import type {
  PackConditionalTopicsTopic,
  PackModel,
  PackSetupItem,
} from '@/lib/app/questionnaire/export/build-pack-model';
import { QUESTION_FIDELITY_LABELS } from '@/lib/app/questionnaire/types';
import type { InstrumentQuestion } from '@/lib/app/questionnaire/export/build-instrument-model';

const COLORS = {
  text: '#1a1a1a',
  muted: '#6b7280',
  faint: '#9ca3af',
  accent: PACK_BRAND.brandMarigold,
  hairline: '#e5e7eb',
  // A very pale warm wash for the reconciled-wording panel. Deliberately near-white: it has to
  // separate the resolution from the verdicts above it without competing with the marigold rule,
  // and it has to stay legible when the pack is printed in greyscale.
  tint: '#fbf7ee',
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
  // The judge scoreboard — one compact line per dimension, no findings.
  evaluationScore: {
    fontSize: 9,
    marginTop: 2,
  },
  // One flagged subject: the question printed once, with its judges beneath.
  evaluationTarget: {
    marginTop: 12,
  },
  evaluationTargetContext: {
    fontSize: 7,
    color: COLORS.faint,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.6,
  },
  evaluationTargetLabel: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    marginTop: 1,
  },
  evaluationTargetMeta: {
    fontSize: 8,
    color: COLORS.faint,
    marginTop: 1,
  },
  evaluationSubheading: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginTop: 10,
  },
  // The reconciled wording — tinted and ruled so it reads as the resolution of the verdicts
  // above it rather than one more opinion among them.
  evaluationAlternatives: {
    marginTop: 6,
    padding: 6,
    backgroundColor: COLORS.tint,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accent,
  },
  evaluationAlternativesLabel: {
    fontSize: 7,
    color: COLORS.faint,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.6,
  },
  evaluationAlternativePrompt: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginTop: 3,
  },
  evaluationAlternativeNote: {
    fontSize: 8,
    color: COLORS.muted,
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
  scopeIntro: {
    fontSize: 8,
    color: COLORS.faint,
    fontFamily: 'Helvetica-Oblique',
    marginTop: 2,
  },
  scopeFacts: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 6,
  },
  scopeSubheading: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginTop: 10,
  },
  scopeTopic: {
    marginTop: 6,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.hairline,
  },
  scopeTopicLabel: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
  scopeTopicMeta: {
    fontSize: 8,
    color: COLORS.faint,
    marginTop: 1,
  },
  scopeTopicDescription: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
  },
  scopeTopicCriteria: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
    fontFamily: 'Helvetica-Oblique',
  },
  scopeRule: {
    fontSize: 9,
    marginTop: 3,
    marginLeft: 8,
  },
  scopeEvaluationEdit: {
    fontSize: 8,
    color: COLORS.muted,
    marginTop: 1,
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
      <Text style={styles.flags}>
        {[
          q.typeLabel,
          q.required ? 'required' : 'optional',
          // Absent entirely when the version's fidelity gate is off.
          ...(q.fidelity ? [`fidelity: ${QUESTION_FIDELITY_LABELS[q.fidelity]}`] : []),
        ].join(' · ')}
      </Text>
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

/** One Conditional topics topic — label, an optional description, and (for a conditional topic) its
 *  plain-English inclusion criteria. */
function ScopeTopicBlock({ topic }: { topic: PackConditionalTopicsTopic }) {
  return (
    <View style={styles.scopeTopic} wrap={false}>
      <Text style={styles.scopeTopicLabel}>{topic.label}</Text>
      {topic.sampledOnly && (
        <Text style={styles.scopeTopicMeta}>Sampled lightly, not asked in full</Text>
      )}
      {topic.description && <Text style={styles.scopeTopicDescription}>{topic.description}</Text>}
      {topic.criteria && (
        <Text style={styles.scopeTopicCriteria}>{`Included when: ${topic.criteria}`}</Text>
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
              <>
                {/* The scoreboard. Findings are not repeated here — they print once, under the
                    question they are about, so a contested question reads as one item. */}
                <Text style={styles.evaluationSubheading}>Judge scores</Text>
                {model.evaluations.scores.map((judge) => (
                  <Text key={judge.dimension} style={styles.evaluationScore}>
                    {judge.diagnostic
                      ? `${judge.label} — unavailable: ${judge.diagnostic}`
                      : `${judge.label} — ${judge.score !== null ? `${Math.round(judge.score * 100)}%` : 'n/a'} · ${judge.findingCount} finding(s)`}
                  </Text>
                ))}

                {model.evaluations.targets.length === 0 ? (
                  <Text style={styles.empty}>No findings raised.</Text>
                ) : (
                  model.evaluations.targets.map((target) => (
                    <View key={target.key} style={styles.evaluationTarget}>
                      {target.context && (
                        <Text style={styles.evaluationTargetContext}>
                          {target.context.toUpperCase()}
                        </Text>
                      )}
                      <Text style={styles.evaluationTargetLabel}>{target.label}</Text>
                      <Text style={styles.evaluationTargetMeta}>
                        {[
                          target.questionType ? `Type: ${target.questionType}` : null,
                          `${target.judgeCount} judge(s)`,
                          target.counts.major > 0 ? `${target.counts.major} major` : null,
                          target.removed ? 'no longer in the questionnaire' : null,
                        ]
                          .filter(Boolean)
                          .join('  ·  ')}
                      </Text>
                      {target.judges.map((judge, i) => (
                        <View key={i} style={styles.evaluationFinding} wrap={false}>
                          <Text
                            style={styles.evaluationFindingHeader}
                          >{`${judge.label}  [${judge.severity} · ${judge.status}]`}</Text>
                          <Text style={styles.evaluationFindingBody}>{judge.proposedChange}</Text>
                          <Text style={styles.evaluationFindingBody}>{judge.rationale}</Text>
                        </View>
                      ))}
                      {/* Last, after the verdicts it reconciles — it reads as an answer only once
                          the reader has seen the disagreement. */}
                      {target.alternatives.length > 0 && (
                        <View style={styles.evaluationAlternatives}>
                          <Text style={styles.evaluationAlternativesLabel}>
                            {target.alternatives.length === 1
                              ? 'SUGGESTED REWORDING'
                              : 'SUGGESTED REWORDINGS'}
                          </Text>
                          {target.alternatives.map((alt, i) => (
                            <View key={i} wrap={false}>
                              <Text style={styles.evaluationAlternativePrompt}>{alt.prompt}</Text>
                              <Text style={styles.evaluationAlternativeNote}>
                                {`Addresses: ${alt.addresses.join(', ')}. ${alt.note}`}
                              </Text>
                            </View>
                          ))}
                          {target.unresolvedBy.length > 0 && (
                            <Text style={styles.evaluationAlternativeNote}>
                              {`Not resolved by rewording: ${target.unresolvedBy.join(', ')} — these need a structural change.`}
                            </Text>
                          )}
                        </View>
                      )}
                    </View>
                  ))
                )}
              </>
            )}
          </View>
        )}

        {model.conditionalTopics && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Conditional topics</Text>
            <Text style={styles.scopeIntro}>
              How this questionnaire adapts to each respondent — which parts everyone gets, which
              parts depend on what they say, and the rules that decide.
            </Text>
            {!model.conditionalTopics.enabled ? (
              <Text style={styles.empty}>
                Conditional topics is not enabled for this version — every respondent is asked the
                full instrument.
              </Text>
            ) : (
              <>
                <Text style={styles.scopeFacts}>
                  {[
                    `Up to ${model.conditionalTopics.maxConditionalTopics} conditional topic(s) per interview`,
                    model.conditionalTopics.includeCheckTopic
                      ? 'one additional, unselected topic is sampled lightly to check for blind spots'
                      : null,
                    model.conditionalTopics.sessionBudgetSeconds > 0
                      ? `interviews are budgeted to about ${Math.round(model.conditionalTopics.sessionBudgetSeconds / 60)} minute(s)`
                      : null,
                  ]
                    .filter(Boolean)
                    .join('  ·  ')}
                </Text>

                <Text style={styles.scopeSubheading}>Always asked</Text>
                {model.conditionalTopics.alwaysAsked.length === 0 ? (
                  <Text style={styles.empty}>None defined.</Text>
                ) : (
                  model.conditionalTopics.alwaysAsked.map((topic) => (
                    <ScopeTopicBlock key={topic.key} topic={topic} />
                  ))
                )}

                <Text style={styles.scopeSubheading}>Asked when it fits</Text>
                {model.conditionalTopics.conditional.length === 0 ? (
                  <Text style={styles.empty}>None defined.</Text>
                ) : (
                  model.conditionalTopics.conditional.map((topic) => (
                    <ScopeTopicBlock key={topic.key} topic={topic} />
                  ))
                )}

                {model.conditionalTopics.rules.length > 0 && (
                  <>
                    <Text style={styles.scopeSubheading}>Hard rules</Text>
                    {model.conditionalTopics.rules.map((rule, i) => (
                      <Text key={i} style={styles.scopeRule}>{`•  ${rule.sentence}`}</Text>
                    ))}
                  </>
                )}

                <Text style={styles.scopeSubheading}>Scope evaluation</Text>
                <Text style={styles.evaluationIntro}>
                  AI judge panel over the routing design above — includes findings not yet reviewed;
                  treat as suggestions, not conclusions.
                </Text>
                {!model.conditionalTopics.evaluation.hasRun ? (
                  <Text style={styles.empty}>
                    No scope evaluation has been run for this version yet.
                  </Text>
                ) : (
                  <>
                    {model.conditionalTopics.evaluation.scores.map((judge) => (
                      <Text key={judge.dimension} style={styles.evaluationScore}>
                        {judge.diagnostic
                          ? `${judge.label} — unavailable: ${judge.diagnostic}`
                          : `${judge.label} — ${judge.score !== null ? `${Math.round(judge.score * 100)}%` : 'n/a'} · ${judge.findingCount} finding(s)`}
                      </Text>
                    ))}

                    {model.conditionalTopics.evaluation.targets.length === 0 ? (
                      <Text style={styles.empty}>No findings raised.</Text>
                    ) : (
                      model.conditionalTopics.evaluation.targets.map((target) => (
                        <View key={target.key} style={styles.evaluationTarget}>
                          <Text style={styles.evaluationTargetLabel}>{target.label}</Text>
                          <Text style={styles.evaluationTargetMeta}>
                            {[
                              `${target.judges.length} finding(s)`,
                              target.counts.major > 0 ? `${target.counts.major} major` : null,
                              target.removed ? 'no longer in the scope config' : null,
                            ]
                              .filter(Boolean)
                              .join('  ·  ')}
                          </Text>
                          {target.judges.map((judge, i) => (
                            <View key={i} style={styles.evaluationFinding} wrap={false}>
                              <Text
                                style={styles.evaluationFindingHeader}
                              >{`${judge.label}  [${judge.severity} · ${judge.status}]`}</Text>
                              <Text style={styles.evaluationFindingBody}>
                                {judge.proposedChange}
                              </Text>
                              <Text style={styles.evaluationFindingBody}>{judge.rationale}</Text>
                              {judge.proposedEditSummary && (
                                <Text style={styles.scopeEvaluationEdit}>
                                  {`Proposed edit: ${judge.proposedEditSummary}`}
                                </Text>
                              )}
                            </View>
                          ))}
                        </View>
                      ))
                    )}
                  </>
                )}
              </>
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
