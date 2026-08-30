/**
 * The topic-membership write helpers (F17.35).
 *
 * Before these, every writer hand-built the `{ dataSlotKeys, questionKeys }` object, which is how
 * the 500-key bound came to be enforced on the read path only. Two properties carry real weight
 * here and are asserted directly rather than through a caller:
 *
 *  - the cap matches `narrowTopicMembers`', so a writer can never produce a set the next read
 *    silently truncates (which would orphan whichever question fell off the end, invisibly);
 *  - a no-op returns the SAME object identity, which is what lets a caller iterating every topic
 *    on a version skip the write instead of issuing one UPDATE per topic.
 */

import { describe, it, expect } from 'vitest';

import {
  MEMBER_KEY_MAX_LENGTH,
  TOPIC_MEMBER_LIST_MAX,
  narrowTopicMembers,
  withTopicQuestionKey,
  withoutTopicQuestionKey,
  type TopicMembers,
} from '@/lib/app/questionnaire/scope/types';

function members(questionKeys: string[], dataSlotKeys: string[] = []): TopicMembers {
  return { questionKeys, dataSlotKeys };
}

describe('withTopicQuestionKey', () => {
  it('appends the key, leaving the data slots untouched', () => {
    const next = withTopicQuestionKey(members(['a'], ['slot_1']), 'b');

    expect(next.questionKeys).toEqual(['a', 'b']);
    expect(next.dataSlotKeys).toEqual(['slot_1']);
  });

  it('appends at the end, so authored order is preserved', () => {
    expect(withTopicQuestionKey(members(['b', 'a']), 'c').questionKeys).toEqual(['b', 'a', 'c']);
  });

  it('returns the same object when the key is already a member', () => {
    const before = members(['a', 'b']);

    // Identity, not equality: this is what a caller's `if (next === topic.members) continue`
    // relies on to skip the write.
    expect(withTopicQuestionKey(before, 'b')).toBe(before);
  });

  it('returns the same object for a blank or whitespace-only key', () => {
    const before = members(['a']);

    expect(withTopicQuestionKey(before, '')).toBe(before);
    expect(withTopicQuestionKey(before, '   ')).toBe(before);
  });

  it('trims the key before adding it, so " a" is not a second "a"', () => {
    const before = members(['a']);

    expect(withTopicQuestionKey(before, '  a  ')).toBe(before);
    expect(withTopicQuestionKey(members([]), '  a  ').questionKeys).toEqual(['a']);
  });

  it('truncates an over-long key to the same bound the read path uses', () => {
    const long = 'q'.repeat(MEMBER_KEY_MAX_LENGTH + 50);

    const written = withTopicQuestionKey(members([]), long).questionKeys[0];
    // Round-tripping through the read path must not change it again — that second truncation is
    // what turns a key into one matching no question.
    expect(written).toHaveLength(MEMBER_KEY_MAX_LENGTH);
    expect(narrowTopicMembers({ questionKeys: [written], dataSlotKeys: [] }).questionKeys).toEqual([
      written,
    ]);
  });

  it('is a no-op at the cap rather than producing a list the next read would truncate', () => {
    const full = members(Array.from({ length: TOPIC_MEMBER_LIST_MAX }, (_, i) => `q${i}`));

    // Not an error: 500 members is far past any real topic, and failing a question's creation
    // because its topic is full is a worse answer than the coverage finding that follows.
    expect(withTopicQuestionKey(full, 'one_more')).toBe(full);
  });

  it('never mutates the input', () => {
    const before = members(['a']);
    withTopicQuestionKey(before, 'b');

    expect(before.questionKeys).toEqual(['a']);
  });
});

describe('withoutTopicQuestionKey', () => {
  it('removes the key and keeps the rest in order', () => {
    const next = withoutTopicQuestionKey(members(['a', 'b', 'c'], ['slot_1']), 'b');

    expect(next.questionKeys).toEqual(['a', 'c']);
    expect(next.dataSlotKeys).toEqual(['slot_1']);
  });

  it('returns the same object when the key was never a member', () => {
    const before = members(['a']);

    expect(withoutTopicQuestionKey(before, 'zzz')).toBe(before);
  });

  it('leaves a topic present but empty rather than signalling deletion', () => {
    // An empty topic still carries its label, phase and criteria — an author's work — and
    // `validateConditionalTopics` reports it as `empty_topic`. Pruning is what MAKES that warning
    // fire; removing the topic here would destroy the work and the warning together.
    const next = withoutTopicQuestionKey(members(['only']), 'only');

    expect(next.questionKeys).toEqual([]);
    expect(next).not.toBeNull();
  });

  it('never mutates the input', () => {
    const before = members(['a', 'b']);
    withoutTopicQuestionKey(before, 'a');

    expect(before.questionKeys).toEqual(['a', 'b']);
  });

  it('round-trips with withTopicQuestionKey', () => {
    const before = members(['a', 'b']);
    const after = withoutTopicQuestionKey(withTopicQuestionKey(before, 'c'), 'c');

    expect(after).toEqual(before);
  });
});
