/**
 * Report method record → panel view.
 *
 * Two properties matter here. First, the audience split is enforced by construction: a respondent view
 * must not merely *hide* operational detail, it must not carry it. Second, the panel lists only checks
 * that actually ran — a check listed because it was configured would be exactly the unearned
 * reassurance this feature exists to avoid.
 */

import { describe, it, expect } from 'vitest';

import { buildReportMethodView } from '@/lib/app/questionnaire/report/method-view';
import {
  MethodRecorder,
  renderMethodSummaryTemplate,
  type ReportMethodRecord,
} from '@/lib/app/questionnaire/report/method-record';

function build(mutate: (rec: MethodRecorder) => void = () => {}): ReportMethodRecord {
  const rec = new MethodRecorder('narrative', false, () => 0);
  rec.recordAnswers({
    answered: 34,
    total: 40,
    completionPct: 85,
    unansweredListed: 6,
    confidenceWeighted: true,
    usedDataSlots: false,
  });
  rec.recordPass('coverageFence', true);
  mutate(rec);
  return rec.build();
}

describe('buildReportMethodView — audience split', () => {
  it('omits the admin block entirely from a respondent view', () => {
    const view = buildReportMethodView(build(), 'respondent');
    expect(view.admin).toBeUndefined();
    // Not merely hidden — absent, so no respondent surface can render it by accident.
    expect(Object.hasOwn(view, 'admin')).toBe(false);
  });

  it('includes model, cost, timings, queries and stages in an admin view', () => {
    const record = build((rec) => {
      rec.recordModel({ provider: 'openai', model: 'gpt-5.4', tier: 'reasoning' });
      rec.recordSearches('before', [{ query: 'secret query', resultCount: 3 }]);
      rec.recordKnowledge({
        consulted: true,
        documentsInScope: 4,
        documentsUsed: [{ id: 'd1', name: 'Handbook', snippets: 2 }],
        snippetCount: 2,
      });
      rec.stageSkipped('appendix', 'disabled');
      rec.addCost(0.05);
    });

    const view = buildReportMethodView(record, 'admin');
    expect(view.admin?.model).toEqual({ provider: 'openai', model: 'gpt-5.4', tier: 'reasoning' });
    expect(view.admin?.costUsd).toBeCloseTo(0.05, 6);
    expect(view.admin?.searches).toEqual([
      { phase: 'before', query: 'secret query', resultCount: 3 },
    ]);
    expect(view.admin?.documents).toEqual([{ id: 'd1', name: 'Handbook', snippets: 2 }]);
    expect(view.admin?.stages).toContainEqual({
      key: 'appendix',
      ran: false,
      skipReason: 'disabled',
    });
  });

  it('never exposes search queries or document names to a respondent', () => {
    const record = build((rec) => {
      rec.recordSearches('before', [{ query: 'internal query', resultCount: 3 }]);
      rec.recordKnowledge({
        consulted: true,
        documentsInScope: 4,
        documentsUsed: [{ id: 'd1', name: 'Confidential Handbook', snippets: 2 }],
        snippetCount: 2,
      });
    });

    const serialised = JSON.stringify(buildReportMethodView(record, 'respondent'));
    expect(serialised).not.toContain('internal query');
    expect(serialised).not.toContain('Confidential Handbook');
  });
});

describe('buildReportMethodView — facts', () => {
  it('renders partial coverage as a fraction and full coverage as "All"', () => {
    const partial = buildReportMethodView(build(), 'respondent');
    expect(partial.facts.find((f) => f.key === 'answers')?.value).toBe('34 of 40');

    const complete = buildReportMethodView(
      (() => {
        const rec = new MethodRecorder('narrative', false, () => 0);
        rec.recordAnswers({
          answered: 12,
          total: 12,
          completionPct: 100,
          unansweredListed: 0,
          confidenceWeighted: false,
          usedDataSlots: false,
        });
        return rec.build();
      })(),
      'respondent'
    );
    expect(complete.facts.find((f) => f.key === 'answers')?.value).toBe('All 12');
  });

  it('omits the gaps fact when nothing was left unanswered', () => {
    const record = build((rec) =>
      rec.recordAnswers({
        answered: 10,
        total: 10,
        completionPct: 100,
        unansweredListed: 0,
        confidenceWeighted: false,
        usedDataSlots: false,
      })
    );
    expect(buildReportMethodView(record, 'respondent').facts.map((f) => f.key)).not.toContain(
      'gaps'
    );
  });

  it('omits document and search facts entirely when those stages did not run', () => {
    const keys = buildReportMethodView(build(), 'respondent').facts.map((f) => f.key);
    expect(keys).not.toContain('documents');
    expect(keys).not.toContain('searches');
    expect(keys).not.toContain('sources');
  });

  it('reports zero documents used when the corpus was searched but returned nothing', () => {
    // "Searched and found nothing" is a different claim from "did not search", and the panel makes it.
    const record = build((rec) =>
      rec.recordKnowledge({
        consulted: true,
        documentsInScope: 5,
        documentsUsed: [],
        snippetCount: 0,
      })
    );
    expect(
      buildReportMethodView(record, 'respondent').facts.find((f) => f.key === 'documents')?.value
    ).toBe('0');
  });
});

describe('buildReportMethodView — checks', () => {
  it('lists only checks that actually ran', () => {
    const record = build((rec) => rec.recordPass('formatter', false));
    const checks = buildReportMethodView(record, 'respondent').checks.join(' ');

    expect(checks).toContain('listed as gaps');
    expect(checks).toContain('less weight');
    expect(checks).not.toContain('wording and layout');
  });

  it('claims nothing about web sources when a search ran but kept none', () => {
    // Otherwise the panel renders "web sources were used…" directly above a zero-sources count.
    const record = build((rec) => {
      rec.recordSearches('before', [{ query: 'q', resultCount: 0 }]);
      rec.recordSources([], false);
    });
    const checks = buildReportMethodView(record, 'respondent').checks.join(' ');
    expect(checks).not.toMatch(/web sources/i);
  });

  it('distinguishes research that shaped the prose from research merely listed', () => {
    const informed = build((rec) => {
      rec.recordSearches('before', [{ query: 'q', resultCount: 1 }]);
      rec.recordSources([{ title: 'S', url: 'https://s.test' }], true);
    });
    expect(buildReportMethodView(informed, 'respondent').checks.join(' ')).toContain(
      'general background only'
    );

    const listedOnly = build((rec) => {
      rec.recordSearches('before', [{ query: 'q', resultCount: 1 }]);
      rec.recordSources([{ title: 'S', url: 'https://s.test' }], false);
    });
    expect(buildReportMethodView(listedOnly, 'respondent').checks.join(' ')).toContain(
      'did not shape the writing'
    );
  });
});

describe('buildReportMethodView — sources hidden by the admin', () => {
  /** A record whose admin set the report's sources section to "Don't show". */
  function hiddenSources() {
    return build((rec) => {
      rec.recordSearches('before', [{ query: 'q', resultCount: 2 }]);
      rec.recordSources(
        [
          { title: 'One', url: 'https://one.test' },
          { title: 'Two', url: 'https://two.test' },
        ],
        true,
        true // sourcesHiddenFromRespondent
      );
    });
  }

  it('withholds the links from the respondent but keeps the count', () => {
    const view = buildReportMethodView(hiddenSources(), 'respondent');

    expect(view.sources).toEqual([]);
    // The panel must not under-report what shaped the report, so the count survives.
    expect(view.facts.find((f) => f.key === 'sources')?.value).toBe('2');
    expect(JSON.stringify(view)).not.toContain('one.test');
  });

  it('still tells the respondent how the sources were used', () => {
    // Withholding links must not silently drop the check — the respondent should still know web
    // material was general background rather than facts about them.
    const checks = buildReportMethodView(hiddenSources(), 'respondent').checks.join(' ');
    expect(checks).toContain('general background only');
  });

  it('always shows the full list to an admin', () => {
    const view = buildReportMethodView(hiddenSources(), 'admin');
    expect(view.sources).toEqual([
      { title: 'One', url: 'https://one.test' },
      { title: 'Two', url: 'https://two.test' },
    ]);
  });

  it('shows the links to the respondent when the admin did not hide them', () => {
    const shown = build((rec) => {
      rec.recordSearches('before', [{ query: 'q', resultCount: 1 }]);
      rec.recordSources([{ title: 'One', url: 'https://one.test' }], true, false);
    });
    expect(buildReportMethodView(shown, 'respondent').sources).toEqual([
      { title: 'One', url: 'https://one.test' },
    ]);
  });
});

describe('buildReportMethodView — summary', () => {
  it('uses the stored agent summary when present', () => {
    const record = build();
    record.summary = { text: 'A friendly explanation.', source: 'agent' };
    expect(buildReportMethodView(record, 'respondent').summary).toBe('A friendly explanation.');
  });

  it('falls back to the deterministic template when no summary was stored', () => {
    // The normal case for reports generated while `delivery.explainMethod` was off: the record is
    // captured regardless, so a later opt-in still yields a truthful explanation with no backfill.
    const record = build();
    expect(record.summary).toBeNull();
    expect(buildReportMethodView(record, 'respondent').summary).toBe(
      renderMethodSummaryTemplate(record)
    );
  });

  it('surfaces which path wrote the explanation to admins', () => {
    const record = build();
    expect(buildReportMethodView(record, 'admin').admin?.summarySource).toBe('template');

    record.summary = { text: 'Agent prose.', source: 'agent' };
    expect(buildReportMethodView(record, 'admin').admin?.summarySource).toBe('agent');
  });
});
