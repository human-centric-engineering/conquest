# UI Hooks

Shared client-side hooks under `lib/hooks/`. Entry point for reusable client state primitives.

## `useLocalStorage<T>(key, initial)`

**File:** `lib/hooks/use-local-storage.ts`

SSR-safe state hook synced with `window.localStorage`.

```ts
export function useLocalStorage<T>(
  key: string,
  initial: T
): [T, (value: T | ((prev: T) => T)) => void, () => void];
```

- **Return tuple:** `[value, setValue, remove]`
- **SSR-safe:** on the server, returns `initial` and makes the setter a no-op. A post-mount effect hydrates from storage on the client.
- **JSON round-trip:** values are stringified on write, parsed on read. Invalid JSON falls back to `initial` and logs a warning.
- **Cross-tab sync:** listens for `storage` events so two tabs stay in sync. A null `newValue` (another tab called `removeItem`) resets to `initial`.

### Caveats

- Do **not** store `Date`, `Map`, `Set`, class instances, or functions — they don't survive the JSON round-trip. Store plain data only.
- Version your keys when the stored shape might change (e.g., `sunrise.mything.v1`). Bump the version on breaking changes so stale drafts are ignored silently.

### Example

```tsx
const [draft, setDraft, clearDraft] = useLocalStorage('sunrise.wizard.v1', {
  stepIndex: 0,
  name: '',
});

setDraft((prev) => ({ ...prev, name: 'Alice' }));
// ...later
clearDraft();
```

## `useWizard({ totalSteps, initialIndex? })`

**File:** `lib/hooks/use-wizard.ts`

Pure step-index state machine. Independent of storage — combine with `useLocalStorage` for resume-across-refreshes behaviour.

```ts
interface WizardState {
  stepIndex: number;
  totalSteps: number;
  isFirst: boolean;
  isLast: boolean;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  reset: () => void;
}

export function useWizard(options: { totalSteps: number; initialIndex?: number }): WizardState;
```

- All navigation helpers clamp to `[0, totalSteps - 1]`.
- `goTo` clamps out-of-range indices instead of throwing.
- `reset()` returns to `initialIndex`, not 0.

### Example

```tsx
const wiz = useWizard({ totalSteps: 5 });
<Button onClick={wiz.next} disabled={wiz.isLast}>
  Next
</Button>;
```

## `useCopyToClipboard(resetMs?)`

**File:** `lib/hooks/use-copy-to-clipboard.ts`

Best-effort "copy to clipboard" with a self-clearing "copied!" flag — the
canonical primitive for copy buttons. Owns the reset timer so it's cleared on
unmount and re-armed (not stacked) on a rapid second copy, fixing the
setState-after-unmount leak that an uncleared `setTimeout(() => setCopied(false))`
otherwise causes (issue #301).

```ts
interface UseCopyToClipboardResult {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
}

export function useCopyToClipboard(resetMs?: number): UseCopyToClipboardResult;
```

- **`resetMs`** defaults to `2000`. `copied` is `true` for that window after a
  successful copy, then flips back to `false`.
- **`copy(text)`** writes via `navigator.clipboard.writeText`; resolves `true` on
  success, `false` if the write fails (insecure context / denied permission). The
  failure is swallowed — no timer is armed — so copying is best-effort.
- Keep your own event handling (`e.stopPropagation()`, guards) at the call site;
  the hook only owns copy + the `copied` flag + the reset timer.

### Example

```tsx
const { copied, copy } = useCopyToClipboard();

<Button
  onClick={(e) => {
    e.stopPropagation();
    void copy(text);
  }}
>
  {copied ? <Check /> : <Copy />}
</Button>;
```

## `useHorizontalSwipe(options)`

**File:** `lib/hooks/use-horizontal-swipe.ts`

Drives a horizontal carousel with a **live, follow-the-gesture** drag (not a fire-once
swipe detector). Reports a continuous `dragPx` so the track moves _with_ the gesture and
springs back below a commit threshold; commits a surface change when the gesture clears it.
Covers both horizontal inputs: touch drag (1:1 finger tracking) and trackpad/Magic-Mouse
horizontal wheel bursts (accumulated, with release detection).

```ts
interface HorizontalSwipeState {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  /** Feed raw wheel deltas; returns true when it consumed a horizontal gesture (→ preventDefault). */
  handleWheel: (deltaX: number, deltaY: number) => boolean;
  dragPx: number; // live horizontal offset to add to the track; 0 at rest
  animating: boolean; // true while settling, false while following the gesture
}

export function useHorizontalSwipe(options: {
  onCommitNext?: () => void;
  onCommitPrev?: () => void;
  canPrev?: boolean; // gates the back direction; else rubber-bands
  canNext?: boolean; // gates the forward direction; else rubber-bands
  getWidth?: () => number; // frame width (px) for the commit threshold + clamping
}): HorizontalSwipeState;
```

- **Commit threshold** is 20% of the frame width; a touch/wheel travel past it in an
  allowed direction commits, otherwise the track springs back. A hard wheel burst past
  200px commits instantly, mid-gesture.
- **Axis lock:** a vertical-dominant touch or wheel is handed back to native scroll
  (`handleWheel` returns `false` so the caller does _not_ `preventDefault`). Multi-touch
  (pinch) is ignored.
- **Edge resistance:** dragging toward an edge with no neighbour (`canPrev`/`canNext`
  false) is damped to a short rubber-band so the carousel end feels like a wall.
- **Stable handler identity:** the returned handlers don't change across renders (latest
  props are read through a ref), so `handleWheel` can bind to a native listener once.
  Keyboard navigation is the consumer's responsibility.

## See also

- [Setup Wizard](../admin/setup-wizard.md) — composes both wizard hooks together
- [Contextual help](./contextual-help.md)
