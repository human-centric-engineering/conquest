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

import {
  buildWelcomeTurns,
  DEFAULT_WELCOME_COPY,
  HONESTY_GUIDANCE,
  VOICE_GUIDANCE,
  ANONYMOUS_GUIDANCE,
} from '@/lib/app/questionnaire/chat/greeting';

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

  it('leads with the custom copy then the honesty guidance, with NO begin-nudge', () => {
    // Arrange
    const customCopy = 'Welcome to the Acme survey.';
    const opts = { welcomeCopy: customCopy };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: the branded intro leads, the honesty guidance follows in the same turn (a
    // markdown paragraph break), and the proactive first question still arrives via the
    // auto-kickoff turn -- so no "send a message to begin" nudge is appended.
    expect(turns[0]?.content).toBe(`${customCopy}\n\n${HONESTY_GUIDANCE}`);
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

  it('seeds DEFAULT_WELCOME_COPY then honesty guidance, with NO begin-nudge', () => {
    // Arrange
    const opts = {};

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: the default intro leads, the honesty guidance follows -- the proactive first
    // question still arrives via the auto-kickoff turn, so no "send a message to begin" nudge.
    expect(turns[0]?.content).toBe(`${DEFAULT_WELCOME_COPY}\n\n${HONESTY_GUIDANCE}`);
    expect(turns[0]?.content).not.toContain('send a message to begin');
  });

  it('produces a SINGLE turn so the auto-kickoff still fires (guidance folds into the intro turn)', () => {
    // Arrange
    const opts = {};

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: exactly one assistant turn -- the kickoff guard fires only while a single
    // greeting turn is present, so the guidance must share the turn (a "\n\n" markdown break)
    // rather than become a second turn that would suppress the proactive first question.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toContain('\n\n');
    expect(turns[0]?.content).toContain(DEFAULT_WELCOME_COPY);
    expect(turns[0]?.content).toContain(HONESTY_GUIDANCE);
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

  it('seeds the default intro + honesty guidance (no begin-nudge) when falling back from whitespace', () => {
    // Arrange
    const opts = { welcomeCopy: '   ' };

    // Act
    const turns = buildWelcomeTurns(opts);

    // Assert: fallback yields the default intro plus guidance -- consistent with a fresh seed.
    expect(turns[0]?.content).toBe(`${DEFAULT_WELCOME_COPY}\n\n${HONESTY_GUIDANCE}`);
    expect(turns[0]?.content).not.toContain('send a message to begin');
  });
});

// ---------------------------------------------------------------------------
// buildWelcomeTurns -- pre-flight guidance (honesty / voice / anonymity)
// ---------------------------------------------------------------------------

describe('buildWelcomeTurns -- pre-flight guidance', () => {
  it('always appends the honesty advice on a fresh session', () => {
    // Arrange / Act: no guidance flags set -- honesty is universal.
    const turns = buildWelcomeTurns({});

    // Assert
    expect(turns[0]?.content).toContain(HONESTY_GUIDANCE);
  });

  it('omits the voice nudge when voice input is disabled', () => {
    // Arrange / Act
    const turns = buildWelcomeTurns({ voiceInputEnabled: false });

    // Assert: no mic mention when the affordance is not shown.
    expect(turns[0]?.content).not.toContain(VOICE_GUIDANCE);
  });

  it('includes the voice nudge when voice input is enabled', () => {
    // Arrange / Act
    const turns = buildWelcomeTurns({ voiceInputEnabled: true });

    // Assert: the mic suggestion appears alongside the honesty advice.
    expect(turns[0]?.content).toContain(HONESTY_GUIDANCE);
    expect(turns[0]?.content).toContain(VOICE_GUIDANCE);
  });

  it('omits the anonymity reassurance when the questionnaire is not anonymous', () => {
    // Arrange / Act
    const turns = buildWelcomeTurns({ anonymous: false });

    // Assert: never promise anonymity that the config does not grant.
    expect(turns[0]?.content).not.toContain(ANONYMOUS_GUIDANCE);
  });

  it('includes the anonymity reassurance when the questionnaire is anonymous', () => {
    // Arrange / Act
    const turns = buildWelcomeTurns({ anonymous: true });

    // Assert: the "won't be passed on" reassurance appears.
    expect(turns[0]?.content).toContain(ANONYMOUS_GUIDANCE);
  });

  it('composes honesty + voice + anonymity together in one turn when all apply', () => {
    // Arrange / Act
    const turns = buildWelcomeTurns({ voiceInputEnabled: true, anonymous: true });

    // Assert: a single turn carrying all three pieces of guidance after the intro.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toContain(DEFAULT_WELCOME_COPY);
    expect(turns[0]?.content).toContain(HONESTY_GUIDANCE);
    expect(turns[0]?.content).toContain(VOICE_GUIDANCE);
    expect(turns[0]?.content).toContain(ANONYMOUS_GUIDANCE);
  });

  it('skips ALL pre-flight guidance on a resumed session (the respondent already saw it)', () => {
    // Arrange / Act: resume wins even with guidance flags set.
    const turns = buildWelcomeTurns({ resumed: true, voiceInputEnabled: true, anonymous: true });

    // Assert: the resume copy stands alone -- no honesty / voice / anonymity lines.
    expect(turns[0]?.content).toContain('Welcome back');
    expect(turns[0]?.content).not.toContain(HONESTY_GUIDANCE);
    expect(turns[0]?.content).not.toContain(VOICE_GUIDANCE);
    expect(turns[0]?.content).not.toContain(ANONYMOUS_GUIDANCE);
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
