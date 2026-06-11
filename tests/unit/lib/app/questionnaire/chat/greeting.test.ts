/**
 * buildWelcomeTurns -- seed transcript copy for the respondent chat surface (F7.1).
 *
 * Pure function: no I/O, no React. Tests assert exact strings because the copy
 * is user-facing and a regression here silently ships wrong words.
 *
 * String encoding note: the source file uses straight apostrophes (0x27) and an
 * em dash (U+2014). Rather than embed those exact bytes in test constants and risk
 * editor/encoding mismatches, we use the imported DEFAULT_WELCOME_COPY directly as
 * the ground truth and verify behaviour via substring checks and structural equality.
 *
 * @see lib/app/questionnaire/chat/greeting.ts
 */

import { describe, it, expect } from 'vitest';

import { buildWelcomeTurns, DEFAULT_WELCOME_COPY } from '@/lib/app/questionnaire/chat/greeting';

// ---------------------------------------------------------------------------
// DEFAULT_WELCOME_COPY
// ---------------------------------------------------------------------------

describe('DEFAULT_WELCOME_COPY', () => {
  it('is the platform default intro line with the expected key phrases', () => {
    // Arrange / Act -- constant, no act step.
    // Assert key substrings that pin down the copy without embedding encoding-fragile
    // characters (em dash, curly apostrophes) directly in the test source.
    expect(DEFAULT_WELCOME_COPY).toContain('short conversation');
    expect(DEFAULT_WELCOME_COPY).toContain('answer in your own words');
    expect(DEFAULT_WELCOME_COPY).toContain('take care of the rest');
    // Length guard: a deliberate truncation or full replacement is also caught.
    expect(DEFAULT_WELCOME_COPY.length).toBeGreaterThan(60);
  });

  it('is a non-empty string', () => {
    // Arrange / Act -- constant.
    // Assert: structural guard so we catch an accidental empty export.
    expect(typeof DEFAULT_WELCOME_COPY).toBe('string');
    expect(DEFAULT_WELCOME_COPY.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildWelcomeTurns -- resumed session
// ---------------------------------------------------------------------------

describe('buildWelcomeTurns -- resumed session', () => {
  it('returns exactly one assistant turn when resumed=true', () => {
    // Arrange
    const opts = { resumed: true };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: one turn, correct role.
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'assistant' });
  });

  it('uses the resume acknowledgement copy (not the fresh welcome)', () => {
    // Arrange
    const opts = { resumed: true };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: the content mentions picking up where the respondent left off.
    expect(turns[0]?.content).toContain('Welcome back');
    expect(turns[0]?.content).toContain('your answers so far are saved');
    expect(turns[0]?.content).toContain('pick up where we left off');
  });

  it('does NOT append the begin-nudge in a resumed session', () => {
    // Arrange
    const opts = { resumed: true };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: the nudge copy is absent -- it would confuse a returning respondent.
    expect(turns[0]?.content).not.toContain('send a message to begin');
  });

  it('does NOT include DEFAULT_WELCOME_COPY in a resumed session', () => {
    // Arrange
    const opts = { resumed: true };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: the fresh intro is suppressed for resumed sessions.
    expect(turns[0]?.content).not.toContain('answer in your own words');
  });

  it('ignores welcomeCopy when the session is resumed', () => {
    // Arrange: custom copy supplied but session is resumed -- resume copy wins.
    const opts = { resumed: true, welcomeCopy: 'Custom brand copy' };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: custom copy is NOT used; the resume message overrides it.
    expect(turns[0]?.content).not.toContain('Custom brand copy');
    expect(turns[0]?.content).toContain('Welcome back');
  });
});

// ---------------------------------------------------------------------------
// buildWelcomeTurns -- fresh session, custom welcomeCopy
// ---------------------------------------------------------------------------

describe('buildWelcomeTurns -- fresh session with custom welcomeCopy', () => {
  it('uses the custom copy as the intro line', () => {
    // Arrange
    const customCopy = 'Welcome to the Acme survey.';
    const opts = { welcomeCopy: customCopy };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: intro line is the branded copy, not the platform default.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toContain(customCopy);
    expect(turns[0]?.content).not.toContain(DEFAULT_WELCOME_COPY);
  });

  it('seeds the custom copy alone with NO begin-nudge (the first question is auto-streamed)', () => {
    // Arrange
    const customCopy = 'Welcome to the Acme survey.';
    const opts = { welcomeCopy: customCopy };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: the fresh seed is exactly the branded intro -- the proactive first question now
    // arrives via the auto-kickoff turn, so no "send a message to begin" nudge is appended.
    expect(turns[0]?.content).toBe(customCopy);
    expect(turns[0]?.content).not.toContain('send a message to begin');
  });
});

// ---------------------------------------------------------------------------
// buildWelcomeTurns -- fresh session, no welcomeCopy (falls back to default)
// ---------------------------------------------------------------------------

describe('buildWelcomeTurns -- fresh session with no welcomeCopy', () => {
  it('uses DEFAULT_WELCOME_COPY as the intro line when welcomeCopy is omitted', () => {
    // Arrange
    const opts = {};

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: content includes the platform default, not an empty string.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toContain(DEFAULT_WELCOME_COPY);
  });

  it('seeds DEFAULT_WELCOME_COPY alone with NO begin-nudge (the first question is auto-streamed)', () => {
    // Arrange
    const opts = {};

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: the fresh seed is exactly the default intro -- the proactive first question now
    // arrives via the auto-kickoff turn, so no "send a message to begin" nudge is appended.
    expect(turns[0]?.content).toBe(DEFAULT_WELCOME_COPY);
    expect(turns[0]?.content).not.toContain('send a message to begin');
  });

  it('produces a single-turn seed of exactly the intro line (no second nudge part)', () => {
    // Arrange
    const opts = {};

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: one assistant turn whose content is the intro line verbatim -- no "\n\n" join.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toBe(DEFAULT_WELCOME_COPY);
    expect(turns[0]?.content).not.toContain('\n\n');
  });

  it('uses DEFAULT_WELCOME_COPY when welcomeCopy is undefined explicitly', () => {
    // Arrange
    const opts = { welcomeCopy: undefined };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert
    expect(turns[0]?.content).toContain(DEFAULT_WELCOME_COPY);
  });
});

// ---------------------------------------------------------------------------
// buildWelcomeTurns -- whitespace-only welcomeCopy falls back to default
// ---------------------------------------------------------------------------

describe('buildWelcomeTurns -- whitespace-only welcomeCopy', () => {
  it('falls back to DEFAULT_WELCOME_COPY when welcomeCopy is all spaces', () => {
    // Arrange: the source does `welcomeCopy?.trim() || DEFAULT_WELCOME_COPY`
    const opts = { welcomeCopy: '   ' };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: whitespace-only is treated the same as absent -- default is used.
    expect(turns[0]?.content).toContain(DEFAULT_WELCOME_COPY);
    expect(turns[0]?.content).not.toContain('   ');
  });

  it('falls back to DEFAULT_WELCOME_COPY when welcomeCopy is a tab character', () => {
    // Arrange
    const opts = { welcomeCopy: '\t' };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert
    expect(turns[0]?.content).toContain(DEFAULT_WELCOME_COPY);
  });

  it('seeds the default intro alone (no begin-nudge) when falling back from a whitespace-only copy', () => {
    // Arrange
    const opts = { welcomeCopy: '   ' };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: fallback yields exactly the default intro -- no nudge, consistent with a fresh seed.
    expect(turns[0]?.content).toBe(DEFAULT_WELCOME_COPY);
    expect(turns[0]?.content).not.toContain('send a message to begin');
  });
});

// ---------------------------------------------------------------------------
// buildWelcomeTurns -- return shape
// ---------------------------------------------------------------------------

describe('buildWelcomeTurns -- return shape', () => {
  it('always returns an array of QuestionnaireTurn objects with role=assistant', () => {
    // Arrange
    const cases = [
      {},
      { resumed: true },
      { welcomeCopy: 'Hi' },
      { resumed: false, welcomeCopy: 'Hi' },
    ];

    for (const opts of cases) {
      // Act
      const turns = buildWelcomeTurns(opts);

      // Assert: structural contract -- every turn has the right role and string content.
      for (const turn of turns) {
        expect(turn.role).toBe('assistant');
        expect(typeof turn.content).toBe('string');
        expect(turn.content.length).toBeGreaterThan(0);
      }
    }
  });
});
