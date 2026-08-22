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
import { QUESTION_FIDELITY_LABELS } from '@/lib/app/questionnaire/types';
import { PACK_BRAND } from '@/lib/app/questionnaire/export/pack-brand';
import type { PackModel } from '@/lib/app/questionnaire/export/build-pack-model';

/** One CSV row from raw cell values. */
function row(cells: string[]): string {
  return cells.map(csvEscape).join(',');
}

/** Serialise the pack model to a CSV document — one block per included section. */
export function buildPackCsv(model: PackModel): string {
  const blocks: string[][] = [];

  blocks.push([
    row(['ConQuest', PACK_BRAND.tagline, PACK_BRAND.website]),
    row(['Questionnaire pack', model.title]),
    row(['Generated', model.generatedAt]),
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
    // Two blocks, mirroring the model's split: the judge scoreboard, then the findings.
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

    // One row per (target, judge) pair, in questionnaire order, target columns first — so the
    // block sorts and pivots by the thing under review rather than by which judge spoke.
    //
    // The target's text DOES repeat down the rows of a contested question, unlike the PDF and
    // Markdown packs. That is deliberate: a CSV row has to stand alone to survive a sort, a
    // filter, or a pivot, and blanking the continuation rows would break all three. The
    // "name the question once" rule is about the documents a person reads top to bottom.
    // `!hasRun` yields zero targets, so the block degrades to header-only — the same "nothing
    // here" shape empty dataSlots/sections use.
    const findingRows = model.evaluations.targets.flatMap((target) =>
      target.judges.map((judge) =>
        row([
          target.key,
          target.context ?? '',
          target.label,
          target.questionType ?? '',
          judge.dimension,
          judge.label,
          judge.severity,
          judge.status,
          judge.proposedChange,
          judge.rationale,
          judge.sourceQuote ?? '',
        ])
      )
    );
    // Alternatives are their own block: one row per proposed phrasing. Folding them into the
    // findings rows would either duplicate every judge row or leave most of them blank.
    const alternativeRows = model.evaluations.targets.flatMap((target) =>
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
    );
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
      ...alternativeRows,
    ]);

    blocks.push([
      '# Evaluation',
      row([
        'target_key',
        'target_context',
        'target',
        'target_type',
        'dimension',
        'judge',
        'severity',
        'status',
        'proposed_change',
        'rationale',
        'source_quote',
      ]),
      ...findingRows,
    ]);
  }

  if (model.adaptiveScope) {
    blocks.push([
      '# Adaptive scope',
      row(['field', 'value']),
      row(['Enabled', model.adaptiveScope.enabled ? 'yes' : 'no']),
      row([
        'Max conditional topics per interview',
        String(model.adaptiveScope.maxConditionalTopics),
      ]),
      row([
        'Samples one unselected topic to check for blind spots',
        model.adaptiveScope.includeCheckTopic ? 'yes' : 'no',
      ]),
      row([
        'Session time budget',
        model.adaptiveScope.sessionBudgetSeconds > 0
          ? `${model.adaptiveScope.sessionBudgetSeconds}s`
          : 'no limit set',
      ]),
    ]);

    blocks.push([
      '# Adaptive scope topics',
      row(['key', 'label', 'description', 'always_asked', 'criteria', 'sampled_only']),
      ...[...model.adaptiveScope.alwaysAskedTopics, ...model.adaptiveScope.conditionalTopics].map(
        (topic) =>
          row([
            topic.key,
            topic.label,
            topic.description ?? '',
            topic.alwaysAsked ? 'yes' : 'no',
            topic.criteria ?? '',
            topic.sampledOnly ? 'yes' : 'no',
          ])
      ),
    ]);

    blocks.push([
      '# Adaptive scope rules',
      row(['rule']),
      ...model.adaptiveScope.rules.map((rule) => row([rule.sentence])),
    ]);

    const evaluation = model.adaptiveScope.evaluation;
    blocks.push([
      '# Scope evaluation judge scores',
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
          judge.status,
          judge.proposedChange,
          judge.rationale,
          judge.proposedEditSummary ?? '',
          judge.sourceQuote ?? '',
        ])
      )
    );
    blocks.push([
      '# Scope evaluation findings',
      row([
        'target_key',
        'target_kind',
        'target',
        'target_removed',
        'dimension',
        'judge',
        'severity',
        'status',
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
          'status',
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
              j.status,
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
