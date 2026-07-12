/**
 * Incremental "questions so far" counter for a streaming extraction response.
 *
 * The extractor emits ONE JSON object — `{ "sections": [...], "questions": [...],
 * "changes": [...], … }` — as a token stream. To show the admin a live count
 * ("12 questions extracted so far…") we need to know how many entries of the
 * top-level `questions` array have *closed* in the bytes received so far, WITHOUT
 * waiting for (or fully parsing) the incomplete document.
 *
 * This is a minimal, forward-only JSON state machine. It is fed the raw text
 * deltas as they arrive and, after each `push`, reports how many complete objects
 * have appeared as direct elements of the `questions` array. It is deliberately:
 *
 *   - **Key-anchored, not order-dependent.** A question is counted only when an
 *     object closes whose immediate parent is the array bound to the root key
 *     `"questions"`. The model is free to emit `sections` before or after
 *     `questions`; nested objects/arrays inside a question (a `suggestedTypeConfig`
 *     object, an `options`/`rows`/`choices` array of objects) never miscount,
 *     because their parent container is not the questions array.
 *   - **Incremental.** State persists across `push` calls, so a 128 KB response
 *     is scanned once end-to-end, not re-parsed per chunk (no O(n²) blow-up).
 *   - **Split-safe.** A chunk boundary can fall anywhere — mid-string, mid-escape,
 *     between a key and its colon — and the running count stays correct.
 *
 * It is a *counter*, not a validator: it does not verify the document is
 * well-formed. The authoritative parse still happens once on the assembled text
 * (the capability's `parse` callback). If the stream is malformed the count may
 * be approximate, which is acceptable for a progress indicator that a real parse
 * supersedes.
 *
 * Pure and dependency-free — safe under the `lib/app/**` boundary (no Prisma, no
 * Next.js).
 */

/** The root key whose array elements are counted. */
const QUESTIONS_KEY = 'questions';

/** A container currently open on the scan stack. */
interface Frame {
  type: 'object' | 'array';
  /**
   * The key this container is bound to in its parent object (or `null` when the
   * parent is an array or the document root). Used to recognise the `questions`
   * array by name rather than by position.
   */
  key: string | null;
  /**
   * Object frames only: the key whose value is currently being read (set on
   * `:`, cleared on `,` or on the value's close). Names the child container that
   * opens next.
   */
  pendingKey: string | null;
  /**
   * Object frames only: the most recent completed string literal, a candidate
   * key promoted to `pendingKey` when the following `:` arrives.
   */
  candidateKey: string | null;
  /** Object frames only: `true` when this object is a direct `questions` element. */
  isQuestion: boolean;
}

export interface QuestionCountScanner {
  /**
   * Feed the next raw text delta. Returns the running count of complete
   * `questions` array elements seen so far (monotonically non-decreasing).
   */
  push(chunk: string): number;
  /** The current count without feeding more input. */
  readonly count: number;
}

/**
 * Create a fresh, stateful scanner. One per extraction stream — do not share
 * across responses (state is mutated in place).
 */
export function createQuestionCountScanner(): QuestionCountScanner {
  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;
  /** Buffer for the string literal currently being read. */
  let literal = '';
  let completed = 0;

  const top = (): Frame | undefined => stack[stack.length - 1];

  /** Resolve the key a newly opened child container should carry. */
  function keyForChild(): string | null {
    const parent = top();
    if (!parent) return null; // root container
    if (parent.type === 'object') return parent.pendingKey;
    return null; // array elements have no key
  }

  function openObject(): void {
    const parent = top();
    // Count ONLY direct elements of the document's TOP-LEVEL `questions` array —
    // not any array that merely happens to be keyed `questions` at some deeper
    // level (a `suggestedTypeConfig` or a `changes[].beforeJson` is open-ended
    // and could nest such a field, which would otherwise inflate the count).
    // The top-level array is a child of the root object, so at the moment one of
    // its element objects opens the stack is exactly `[rootObject, questionsArray]`
    // (length 2) with that array on top.
    const isQuestion =
      stack.length === 2 && parent?.type === 'array' && parent.key === QUESTIONS_KEY;
    stack.push({
      type: 'object',
      key: keyForChild(),
      pendingKey: null,
      candidateKey: null,
      isQuestion,
    });
  }

  function openArray(): void {
    stack.push({
      type: 'array',
      key: keyForChild(),
      pendingKey: null,
      candidateKey: null,
      isQuestion: false,
    });
  }

  function closeContainer(): void {
    const frame = stack.pop();
    if (frame?.type === 'object' && frame.isQuestion) completed += 1;
    // The value under the parent's pending key is now fully consumed; a stray
    // key that follows without a comma still resets cleanly on the next `:`.
    const parent = top();
    if (parent?.type === 'object') parent.pendingKey = null;
  }

  /** A string literal just finished — decide whether it's a key or a value. */
  function onStringComplete(value: string): void {
    const frame = top();
    if (frame?.type === 'object') {
      if (frame.pendingKey === null) {
        // Awaiting a key: this string is a candidate key (confirmed on `:`).
        frame.candidateKey = value;
      } else {
        // It's the string value for the pending key — value consumed.
        frame.pendingKey = null;
      }
    }
    // Array element strings and root-level strings need no bookkeeping.
  }

  function onColon(): void {
    const frame = top();
    if (frame?.type === 'object' && frame.candidateKey !== null) {
      frame.pendingKey = frame.candidateKey;
      frame.candidateKey = null;
    }
  }

  function onComma(): void {
    const frame = top();
    if (frame?.type === 'object') {
      frame.pendingKey = null;
      frame.candidateKey = null;
    }
  }

  function push(chunk: string): number {
    for (let i = 0; i < chunk.length; i += 1) {
      const c = chunk[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          literal += c;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === '"') {
          inString = false;
          onStringComplete(literal);
          literal = '';
        } else {
          literal += c;
        }
        continue;
      }

      switch (c) {
        case '"':
          inString = true;
          literal = '';
          break;
        case '{':
          openObject();
          break;
        case '[':
          openArray();
          break;
        case '}':
        case ']':
          closeContainer();
          break;
        case ':':
          onColon();
          break;
        case ',':
          onComma();
          break;
        default:
          // Whitespace and primitive value characters (digits, t/f/n of
          // true/false/null) need no structural handling — a primitive value's
          // pending key is reset by the following `,` or container close.
          break;
      }
    }
    return completed;
  }

  return {
    push,
    get count() {
      return completed;
    },
  };
}
