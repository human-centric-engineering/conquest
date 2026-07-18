/**
 * Report method record — the observed account of a generation run.
 *
 * These tests exist because the record is the *only* thing standing between the respondent-facing
 * "How this report was created" panel and confident fiction. They assert two properties:
 *  1. the recorder reports what happened, including stages that did NOT run and why;
 *  2. the read path refuses anything it cannot vouch for (absent / malformed / future-schema),
 *     rather than defaulting into a plausible-looking husk.
 */

import { describe, it, expect } from 'vitest';

import {
  MethodRecorder,
  narrowMethodRecord,
  renderMethodSummaryTemplate,
  REPORT_METHOD_SCHEMA_VERSION,
  type ReportMethodRecord,
} from '@/lib/app/questionnaire/report/method-record';

/** A recorder with a controllable clock so `durationMs` is deterministic. */
function recorder(preview = false) {
  let now = 1000;
  const rec = new MethodRecorder('narrative', preview, () => now);
  return { rec, advance: (ms: number) => (now += ms) };
}

/** A fully-populated record, as a starting point for read-path tests. */
function fullRecord(): ReportMethodRecord {
  const { rec, advance } = recorder();
  rec.stageRan('answers');
  rec.recordAnswers({
    answered: 34,
    total: 40,
    completionPct: 85,
    unansweredListed: 6,
    confidenceWeighted: true,
    usedDataSlots: true,
  });
  rec.stageRan('knowledge');
  rec.recordKnowledge({
    consulted: true,
    documentsInScope: 9,
    documentsUsed: [{ id: 'd1', name: 'Handbook', snippets: 2 }],
    snippetCount: 2,
  });
  rec.recordSearches('before', [{ query: 'benchmarks', resultCount: 5 }]);
  rec.recordSources([{ title: 'Source', url: 'https://a.test' }], true);
  rec.recordPass('coverageFence', true);
  rec.recordPass('formatter', true);
  rec.recordModel({ provider: 'openai', model: 'gpt-5.4', tier: 'reasoning' });
  rec.addCost(0.02);
  advance(2500);
  return rec.build();
}

describe('MethodRecorder', () => {
  it('records stages that ran and stages that were skipped, with the reason', () => {
    const { rec } = recorder();
    rec.stageRan('answers');
    rec.stageSkipped('knowledge', 'disabled');
    rec.stageSkipped('research_before', 'unavailable');

    const record = rec.build();
    expect(record.stages).toEqual([
      { key: 'answers', ran: true },
      { key: 'knowledge', ran: false, skipReason: 'disabled' },
      { key: 'research_before', ran: false, skipReason: 'unavailable' },
    ]);
  });

  it('emits stages in pipeline order regardless of the order they were recorded', () => {
    const { rec } = recorder();
    // Deliberately out of order — a later stage recorded before an earlier one.
    rec.stageRan('appendix');
    rec.stageRan('answers');
    rec.stageRan('write');

    expect(rec.build().stages.map((s) => s.key)).toEqual(['answers', 'write', 'appendix']);
  });

  it('distinguishes a failed stage from a disabled one', () => {
    // The distinction is load-bearing: "we didn't look" and "we looked and it broke" must not
    // collapse into the same claim about the system's diligence.
    const { rec } = recorder();
    rec.stageSkipped('knowledge', 'failed');
    expect(rec.build().stages[0]?.skipReason).toBe('failed');
  });

  it('marks research as having run only once a search is actually recorded', () => {
    const { rec } = recorder();
    expect(rec.build().research.ran).toBe(false);

    const { rec: rec2 } = recorder();
    rec2.recordSearches('before', [{ query: 'q', resultCount: 3 }]);
    expect(rec2.build().research.ran).toBe(true);
  });

  it('does not mark research as run for an empty or missing search list', () => {
    // `runReportResearch` is best-effort and may report nothing; provenance bookkeeping must not
    // invent a search round, nor throw.
    const { rec } = recorder();
    rec.recordSearches('before', []);
    rec.recordSearches('after', undefined);
    const record = rec.build();
    expect(record.research.ran).toBe(false);
    expect(record.research.searches).toEqual([]);
  });

  it('tags each search with the phase that issued it', () => {
    const { rec } = recorder();
    rec.recordSearches('before', [{ query: 'first', resultCount: 2 }]);
    rec.recordSearches('after', [{ query: 'second', resultCount: 1 }]);

    expect(rec.build().research.searches).toEqual([
      { phase: 'before', query: 'first', resultCount: 2 },
      { phase: 'after', query: 'second', resultCount: 1 },
    ]);
  });

  it('measures duration from construction to build', () => {
    const { rec, advance } = recorder();
    advance(4200);
    expect(rec.build().durationMs).toBe(4200);
  });

  it('ignores non-finite and negative costs', () => {
    const { rec } = recorder();
    rec.addCost(0.01);
    rec.addCost(Number.NaN);
    rec.addCost(-5);
    expect(rec.build().costUsd).toBeCloseTo(0.01, 6);
  });

  it('builds with a null summary — the narration is attached separately', () => {
    expect(recorder().rec.build().summary).toBeNull();
  });

  it('carries the preview flag through to the record', () => {
    expect(recorder(true).rec.build().preview).toBe(true);
  });
});

describe('renderMethodSummaryTemplate', () => {
  it('states the real coverage and the gaps that were fenced', () => {
    const text = renderMethodSummaryTemplate(fullRecord());
    expect(text).toContain('34');
    expect(text).toContain('40');
    expect(text).toMatch(/6 questions you did not answer/);
  });

  it('says "all" rather than a fraction when everything was answered', () => {
    const { rec } = recorder();
    rec.recordAnswers({
      answered: 12,
      total: 12,
      completionPct: 100,
      unansweredListed: 0,
      confidenceWeighted: false,
      usedDataSlots: false,
    });
    const text = renderMethodSummaryTemplate(rec.build());
    expect(text).toContain('all 12 answers');
    expect(text).not.toMatch(/out of/);
  });

  it('is honest when the document search returned nothing', () => {
    const { rec } = recorder();
    rec.recordKnowledge({
      consulted: true,
      documentsInScope: 4,
      documentsUsed: [],
      snippetCount: 0,
    });
    expect(renderMethodSummaryTemplate(rec.build())).toContain('returned nothing relevant');
  });

  it('is honest when searches ran but yielded nothing citable', () => {
    const { rec } = recorder();
    rec.recordSearches('before', [{ query: 'q', resultCount: 0 }]);
    rec.recordSources([], false);
    expect(renderMethodSummaryTemplate(rec.build())).toContain('nothing worth citing');
  });

  it('leads with the sample disclaimer for a preview run', () => {
    const { rec } = recorder(true);
    expect(renderMethodSummaryTemplate(rec.build())).toMatch(/^This is a sample report/);
  });

  it('never mentions a stage that did not run', () => {
    // A record with nothing but answers must not claim documents, research, or a formatting pass.
    const { rec } = recorder();
    rec.recordAnswers({
      answered: 5,
      total: 5,
      completionPct: 100,
      unansweredListed: 0,
      confidenceWeighted: false,
      usedDataSlots: false,
    });
    const text = renderMethodSummaryTemplate(rec.build()).toLowerCase();
    expect(text).not.toContain('document');
    expect(text).not.toContain('web');
    expect(text).not.toContain('formatting');
    expect(text).not.toContain('appendix');
  });
});

describe('narrowMethodRecord', () => {
  it('round-trips a record through JSON unchanged', () => {
    const record = fullRecord();
    expect(narrowMethodRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('returns null for absent or non-object input', () => {
    expect(narrowMethodRecord(null)).toBeNull();
    expect(narrowMethodRecord(undefined)).toBeNull();
    expect(narrowMethodRecord('a string')).toBeNull();
    expect(narrowMethodRecord(42)).toBeNull();
  });

  it('returns null for a record written by a different schema version', () => {
    // Rendering a half-understood record is worse than rendering nothing: the panel would quietly
    // under-report what happened while still presenting itself as the full account.
    const record = { ...fullRecord(), schemaVersion: REPORT_METHOD_SCHEMA_VERSION + 1 };
    expect(narrowMethodRecord(record)).toBeNull();
  });

  it('returns null when the version marker is missing entirely', () => {
    const { schemaVersion: _dropped, ...withoutVersion } = fullRecord();
    expect(narrowMethodRecord(withoutVersion)).toBeNull();
  });

  it('defaults malformed sub-objects rather than throwing', () => {
    const narrowed = narrowMethodRecord({
      schemaVersion: REPORT_METHOD_SCHEMA_VERSION,
      mode: 'narrative',
      answers: 'not an object',
      knowledge: null,
      research: { searches: 'nope', sources: 'nope' },
      passes: undefined,
      stages: 'not an array',
    });
    expect(narrowed).not.toBeNull();
    expect(narrowed!.answers.answered).toBe(0);
    expect(narrowed!.knowledge.documentsUsed).toEqual([]);
    expect(narrowed!.research.searches).toEqual([]);
    expect(narrowed!.research.sources).toEqual([]);
    expect(narrowed!.stages).toEqual([]);
  });

  it('drops a source whose URL is not an http(s) link', () => {
    // These render into an `href`. Ingestion filters non-web schemes today, so this is a read-path
    // backstop matching the guard the report body's own sources already get.
    const narrowed = narrowMethodRecord({
      ...JSON.parse(JSON.stringify(fullRecord())),
      research: {
        ran: true,
        searches: [],
        informedNarrative: false,
        sources: [
          { title: 'Real', url: 'https://real.test' },
          { title: 'XSS', url: 'javascript:alert(document.cookie)' },
          { title: 'Data', url: 'data:text/html,<script>alert(1)</script>' },
          { title: 'Garbage', url: 'not a url' },
        ],
      },
    });
    expect(narrowed!.research.sources).toEqual([{ title: 'Real', url: 'https://real.test' }]);
  });

  it('drops sources with no URL, so nothing unlinkable is presented as a citation', () => {
    const narrowed = narrowMethodRecord({
      ...JSON.parse(JSON.stringify(fullRecord())),
      research: {
        ran: true,
        searches: [],
        informedNarrative: false,
        sources: [{ title: 'Real', url: 'https://real.test' }, { title: 'Ghost' }],
      },
    });
    expect(narrowed!.research.sources).toEqual([{ title: 'Real', url: 'https://real.test' }]);
  });

  it('narrows an unrecognised mode to the default rather than trusting the stored string', () => {
    // The column is external data by the time we read it back; a bare cast would let a legacy or
    // malformed row present an arbitrary string as a valid report mode.
    const narrowed = narrowMethodRecord({
      ...JSON.parse(JSON.stringify(fullRecord())),
      mode: 'not_a_real_mode',
    });
    expect(narrowed!.mode).toBe('narrative');
  });

  it('omits an unrecognised skipReason rather than defaulting one', () => {
    // Defaulting would assert a reason for the skip that was never observed — the exact class of
    // unearned claim the record exists to prevent.
    const narrowed = narrowMethodRecord({
      ...JSON.parse(JSON.stringify(fullRecord())),
      stages: [
        { key: 'knowledge', ran: false, skipReason: 'made_up_reason' },
        { key: 'format', ran: false, skipReason: 'failed' },
      ],
    });
    expect(narrowed!.stages).toEqual([
      { key: 'knowledge', ran: false },
      { key: 'format', ran: false, skipReason: 'failed' },
    ]);
  });

  it('drops stage entries with an unrecognised key', () => {
    const narrowed = narrowMethodRecord({
      ...JSON.parse(JSON.stringify(fullRecord())),
      stages: [
        { key: 'answers', ran: true },
        { key: 'not_a_stage', ran: true },
      ],
    });
    expect(narrowed!.stages).toEqual([{ key: 'answers', ran: true }]);
  });

  it('treats a summary with no text as absent, so the read path falls back to the template', () => {
    const narrowed = narrowMethodRecord({
      ...JSON.parse(JSON.stringify(fullRecord())),
      summary: { text: '', source: 'agent' },
    });
    expect(narrowed!.summary).toBeNull();
  });

  it('coerces an unknown summary source to the template attribution', () => {
    // Claiming an explanation was agent-written when we cannot tell would misreport which path ran.
    const narrowed = narrowMethodRecord({
      ...JSON.parse(JSON.stringify(fullRecord())),
      summary: { text: 'Some prose.', source: 'wat' },
    });
    expect(narrowed!.summary).toEqual({ text: 'Some prose.', source: 'template' });
  });
});
