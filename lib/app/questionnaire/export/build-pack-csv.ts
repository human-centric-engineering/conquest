/**
 * Questionnaire Pack export — CSV serialiser.
 *
 * Unlike the instrument's one-row-per-question CSV (`build-instrument-csv.ts`), the pack is
 * multi-section — meta, data slots, questions, and definitions don't share one table shape. Each
 * included section renders as a self-describing block: a `# Heading` comment row, that block's own
 * header row, then its data rows, with a blank line between blocks. Every cell goes through
 * {@link csvEscape} for RFC 4180 quoting + formula-injection neutralisation. Pure string building, no
 * external library — sibling to `build-instrument-csv.ts` and `build-pack-markdown.ts`.
 */

import { csvEscape } from '@/lib/api/csv';
import { QUESTION_FIDELITY_LABELS, questionTypeLabel } from '@/lib/app/questionnaire/types';
import {
  FINDING_REVIEW_STATUS_LABELS,
  findingSeverityLabel,
} from '@/lib/app/questionnaire/evaluation';
import { formatPackDate, PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';
import type { PackModel } from '@/lib/app/questionnaire/export/build-pack-model';

/** One CSV row from raw cell values. */
function row(cells: string[]): string {
  return cells.map(csvEscape).join(',');
}

/**
 * CSV keeps the RAW enum AND adds a labelled column beside it, rather than replacing one with the
 * other as the prose formats do.
 *
 * A CSV row exists to be sorted, filtered and pivoted, and the raw value is the stable key for all
 * three — a spreadsheet grouping on "Major" breaks the moment the label is reworded, while one
 * grouping on `major` does not. The label column is for the human reading the same sheet, who
 * should not have to learn the enum to read a column. `pending` is written out here, unlike in the
 * prose formats: a blank cell in a spreadsheet reads as missing data, not as "nothing decided yet".
 */
function severityLabelCell(severity: string): string {
  return findingSeverityLabel(severity);
}

function statusLabelCell(status: string): string {
  const labels: Record<string, string> = FINDING_REVIEW_STATUS_LABELS;
  return labels[status] ?? status;
}

/** Serialise the pack model to a CSV document — one block per included section. */
export function buildPackCsv(model: PackModel): string {
  const blocks: string[][] = [];

  blocks.push([
    row(['ConQuest', PACK_BRAND.tagline, PACK_BRAND.website]),
    row(['Questionnaire pack', model.title]),
    row(['Generated', formatPackDate(model.generatedAt) ?? model.generatedAt]),
  ]);

  if (model.meta) {
    blocks.push([
      '# Meta',
      row(['field', 'value']),
      row(['Title', model.title]),
      row(['Version', String(model.versionNumber)]),
      row(['Goal', model.meta.goal ?? '']),
      row(['Audience', model.meta.audienceSummary ?? '']),
      row(['Sections', String(model.sectionCount)]),
      row(['Questions', String(model.questionCount)]),
    ]);
  }

  if (model.setup) {
    // A `group` column rather than a block per group — one flat table filters and pivots in a
    // spreadsheet, which is what the CSV format is for.
    blocks.push([
      '# Experience setup',
      row(['group', 'field', 'value']),
      ...model.setup.map((item) => row([item.group, item.label, item.value])),
    ]);
  }

  if (model.dataSlots) {
    blocks.push([
      '# Data slots',
      row(['key', 'name', 'theme', 'description', 'weight', 'questions']),
      ...model.dataSlots.map((slot) =>
        row([
          slot.key,
          slot.name,
          slot.theme,
          slot.description,
          String(slot.weight),
          slot.questions.map((q) => q.prompt).join(' | '),
        ])
      ),
    ]);
  }

  if (model.sections) {
    const questionRows: string[] = [];
    for (const section of model.sections) {
      for (const q of section.questions) {
        questionRows.push(
          row([
            String(section.number),
            section.title,
            q.number,
            q.key,
            q.prompt,
            q.typeLabel,
            q.required ? 'yes' : 'no',
            String(q.weight),
            q.fidelity ? QUESTION_FIDELITY_LABELS[q.fidelity] : '',
            q.options.join(' | '),
            q.constraint ?? '',
            q.guidelines ?? '',
            q.tags.join(', '),
          ])
        );
      }
    }
    blocks.push([
      '# Questions',
      row([
        'section_number',
        'section_title',
        'question_number',
        'key',
        'prompt',
        'type',
        'required',
        'weight',
        // Empty on every row when the version's fidelity gate is off; the column stays regardless
        // so the CSV shape is stable across exports.
        'fidelity',
        'options',
        'constraint',
        'guidelines',
        'tags',
      ]),
      ...questionRows,
    ]);
  }

  if (model.glossary) {
    blocks.push([
      '# Definitions',
      row(['term', 'definition']),
      ...model.glossary.entries.flatMap((entry) =>
        entry.definitions.map((definition) => row([entry.term, definition]))
      ),
    ]);
  }

  if (model.evaluations) {
    const include = model.include;

    // Blocks mirror the model's split: the judge scoreboard, the panel's verdict per subject, the
    // proposed wordings, then the individual findings. Each is separately included, and each stands
    // alone under a sort or a pivot — which is why the target's text repeats down every one of them
    // rather than being named once as the prose formats do.
    blocks.push([
      '# Judge scores',
      row(['dimension', 'judge', 'score', 'diagnostic', 'finding_count']),
      ...model.evaluations.scores.map((judge) =>
        row([
          judge.dimension,
          judge.label,
          judge.score !== null ? String(judge.score) : '',
          judge.diagnostic ?? '',
          String(judge.findingCount),
        ])
      ),
    ]);

    if (include.evaluationVerdicts) {
      // One row per proposed action, so a contested question is several rows and a spreadsheet can
      // count them. `is_dissent` is the fact a reader loses when they sort: the leading action is
      // the first row of its target only until someone sorts by judge name.
      blocks.push([
        '# Panel verdict',
        row([
          'target_key',
          'target',
          'action',
          'backing',
          'judges',
          'is_dissent',
          'holds_rewording',
        ]),
        ...model.evaluations.targets.flatMap((target) =>
          (target.verdict?.blocks ?? []).map((block, i) =>
            row([
              target.key,
              target.label,
              block.heading,
              block.backing,
              block.judges,
              i === 0 ? 'no' : 'yes',
              block.holdsWording ? 'yes' : 'no',
            ])
          )
        ),
      ]);
    }

    if (include.evaluationRewordings) {
      // Alternatives are their own block: one row per proposed phrasing. Folding them into the
      // findings rows would either duplicate every judge row or leave most of them blank.
      blocks.push([
        '# Suggested rewordings',
        row([
          'target_key',
          'current_wording',
          'suggested_wording',
          'addresses',
          'note',
          'unresolved',
        ]),
        ...model.evaluations.targets.flatMap((target) =>
          target.alternatives.map((alt) =>
            row([
              target.key,
              target.label,
              alt.prompt,
              alt.addresses.join('; '),
              alt.note,
              target.unresolvedBy.join('; '),
            ])
          )
        ),
      ]);
    }

    if (include.evaluationJudgeDetail) {
      blocks.push([
        '# Evaluation',
        row([
          'target_key',
          'target_context',
          'target',
          'target_type',
          'target_type_label',
          'routing_reach',
          'topic',
          'dimension',
          'judge',
          'severity',
          'severity_label',
          'status',
          'status_label',
          'proposed_change',
          'rationale',
          'proposed_edit',
          'destination',
          'reviewer_instruction',
          'source_quote',
        ]),
        ...model.evaluations.targets.flatMap((target) =>
          target.judges.map((judge) =>
            row([
              target.key,
              target.context ?? '',
              target.label,
              target.questionType ?? '',
              target.questionType ? questionTypeLabel(target.questionType) : '',
              target.routingReach ?? '',
              target.topicLabel ?? '',
              judge.dimension,
              judge.label,
              judge.severity,
              severityLabelCell(judge.severity),
              judge.status,
              statusLabelCell(judge.status),
              judge.proposedChange,
              judge.rationale,
              judge.proposedEditSummary ?? '',
              judge.destination ?? '',
              judge.applyInstruction ?? '',
              // Kept in the CSV whatever the evidence flag says. Its reason for defaulting off is
              // that a quote reprints the prompt beside it in a document read top to bottom; a
              // spreadsheet column costs the reader nothing until they widen it.
              judge.sourceQuote ?? '',
            ])
          )
        ),
      ]);
    }
  }

  if (model.conditionalTopics) {
    blocks.push([
      '# Conditional topics',
      row(['field', 'value']),
      row(['Enabled', model.conditionalTopics.enabled ? 'yes' : 'no']),
      // Derived from the routing settings registry, not hand-listed: this block named three of the
      // fifteen settings before, and the ones it missed included whether the respondent is told
      // what was chosen.
      ...model.conditionalTopics.settings.map((item) => row([item.label, item.value])),
    ]);

    const allTopics = [
      ...model.conditionalTopics.alwaysAsked,
      ...model.conditionalTopics.conditional,
    ];

    blocks.push([
      '# Conditional topics topics',
      row([
        'key',
        'label',
        'description',
        'always_asked',
        'criteria',
        'sampled_only',
        'document_trigger',
      ]),
      ...allTopics.map((topic) =>
        row([
          topic.key,
          topic.label,
          topic.description ?? '',
          topic.alwaysAsked ? 'yes' : 'no',
          topic.criteria ?? '',
          topic.sampledOnly ? 'yes' : 'no',
          // What the source document asked to be watched for mid-conversation, when it did.
          // Recorded, not acted on — the topic still runs off its criteria.
          topic.trigger?.condition ?? '',
        ])
      ),
    ]);

    // Membership is its own block, one row per (topic, question): folded into the topics block it
    // would either duplicate every topic row or collapse a list into one unsortable cell. Emitted
    // only when the sub-option is on, in which case `questions` is populated.
    const membershipRows = allTopics.flatMap((topic) =>
      topic.questions.map((q) => row([topic.key, topic.label, q.key, q.prompt]))
    );
    if (membershipRows.length > 0) {
      blocks.push([
        '# Conditional topics membership',
        row(['topic_key', 'topic', 'question_key', 'question']),
        ...membershipRows,
      ]);
    }

    blocks.push([
      '# Conditional topics rules',
      row(['rule']),
      ...model.conditionalTopics.rules.map((rule) => row([rule.sentence])),
    ]);

    const evaluation = model.conditionalTopics.evaluation;
    blocks.push([
      '# Routing review judge scores',
      row(['dimension', 'judge', 'score', 'diagnostic', 'finding_count']),
      ...evaluation.scores.map((judge) =>
        row([
          judge.dimension,
          judge.label,
          judge.score !== null ? String(judge.score) : '',
          judge.diagnostic ?? '',
          String(judge.findingCount),
        ])
      ),
    ]);

    // One row per (target, judge) pair, target columns first — same "the target's text repeats"
    // rule the design-evaluation findings block follows, for the same reason (a CSV row must
    // stand alone under a sort/filter/pivot).
    const scopeFindingRows = evaluation.targets.flatMap((target) =>
      target.judges.map((judge) =>
        row([
          target.key,
          target.kind,
          target.label,
          target.removed ? 'yes' : 'no',
          judge.dimension,
          judge.label,
          judge.severity,
          severityLabelCell(judge.severity),
          judge.status,
          statusLabelCell(judge.status),
          judge.proposedChange,
          judge.rationale,
          judge.proposedEditSummary ?? '',
          judge.sourceQuote ?? '',
        ])
      )
    );
    blocks.push([
      '# Routing review findings',
      row([
        'target_key',
        'target_kind',
        'target',
        'target_removed',
        'dimension',
        'judge',
        'severity',
        'severity_label',
        'status',
        'status_label',
        'proposed_change',
        'rationale',
        'proposed_edit',
        'source_quote',
      ]),
      ...scopeFindingRows,
    ]);
  }

  // ── Interviewer policy (F18.8) ───────────────────────────────────────────
  if (model.interviewerPolicy) {
    const p = model.interviewerPolicy;
    blocks.push([
      '# Interviewer',
      row(['setting', 'value']),
      row(['conversational', p.conversational ? 'yes' : 'no']),
      row(['questioning_approach', p.approachLabel]),
      row(['pace', p.paceLabel ?? '']),
      row(['opening_questions', p.openingSource]),
      row(['tactics', p.tacticLabels.join(' | ')]),
      row(['house_rules_in_force', String(p.houseRules.length)]),
      row(['asked_as_written', p.fidelityEnabled ? 'on' : 'off']),
      row(['questions_word_for_word', String(p.mustAskQuestions.length)]),
    ]);

    if (p.houseRules.length > 0) {
      blocks.push([
        '# Interviewer house rules',
        row(['kind', 'trigger', 'rule']),
        ...p.houseRules.map((r) => row([r.kind, r.trigger ?? '', r.text])),
      ]);
    }

    const policyReview = p.evaluation;
    blocks.push([
      '# Interviewer review scores',
      row(['reviewer', 'score', 'diagnostic', 'findings']),
      ...(policyReview.hasRun
        ? policyReview.scores.map((sc) =>
            row([
              sc.label,
              sc.score === null ? '' : sc.score.toFixed(2),
              sc.diagnostic ?? '',
              String(sc.findingCount),
            ])
          )
        : [row(['(not reviewed)', '', '', '0'])]),
    ]);

    if (policyReview.targets.length > 0) {
      blocks.push([
        '# Interviewer review findings',
        row([
          'subject',
          'reviewer',
          'severity',
          'severity_label',
          'status',
          'status_label',
          'proposed_change',
          'rationale',
          'proposed_edit',
        ]),
        ...policyReview.targets.flatMap((target) =>
          target.judges.map((j) =>
            row([
              target.label,
              j.label,
              j.severity,
              severityLabelCell(j.severity),
              j.status,
              statusLabelCell(j.status),
              j.proposedChange,
              j.rationale,
              j.proposedEditSummary ?? '',
            ])
          )
        ),
      ]);
    }
  }

  return `${blocks.map((block) => block.join('\r\n')).join('\r\n\r\n')}\r\n`;
}
