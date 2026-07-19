# Link QR Codes

Scannable QR codes for the shareable URLs ConQuest exposes to admins — the collective public
respondent link, per-invitee no-login links, and cohort round invites. Each code carries the CQ
mark at its centre and can be downloaded as a PNG or copied to the clipboard as an image.

**Files:**

| Path                                 | Role                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `lib/app/qr/qr-matrix.ts`            | Encoding + geometry. Pure, framework-free, server-safe, unit-tested. |
| `lib/app/qr/render-qr-png.ts`        | Browser-only rasterisation, clipboard write, download trigger.       |
| `components/app/qr/link-qr-code.tsx` | The `LinkQrCode` UI: inline SVG plus Download / Copy image actions.  |

Both renderers derive **all** geometry from `qr-matrix.ts` — `qrPathData` for the modules,
`qrLogoRect` for the white plate, `qrLogoMarkRect` for the mark inside it. Keep it that way: when
the SVG and the canvas each computed their own inset, the on-screen code and the downloaded file
could drift apart, which breaks the one guarantee this feature makes.

Encoding is provided by the `qrcode` package; everything drawn is derived from its module matrix.

## Using it

Most surfaces should not reach for `LinkQrCode` directly — turn it on via `CopyLinkField`, the
canonical "here is a shareable link" row:

```tsx
<CopyLinkField url={url} label="Public link" note={note} showQr />
```

That renders a `QR code` toggle beside `Copy`. Pass `qrLabel` when the surrounding UI already
names the link (a dialog title, say) and a visible `label` would just repeat it — `qrLabel` names
the downloaded file and the code's accessible label without rendering a field label:

```tsx
<CopyLinkField url={revealed.url} showQr qrLabel="No-login link" />
```

Use `<LinkQrCode>` directly only where there is no `CopyLinkField` to hang it off — e.g. the cohort
round-invites list, which shows names rather than URLs and expands one code at a time.

## Design constraints

These are load-bearing. Changing any of them can silently produce a code that renders fine and
does not scan.

- **Error correction is pinned to `H`** (~30% recoverable). This is what makes covering the centre
  with the CQ mark safe rather than lucky. The mark occupies ~5% of the symbol area — well inside
  the budget, but the headroom is the point.
- **Always dark-on-white, regardless of theme.** Scanners expect that polarity, so the QR card is
  explicitly light even in dark mode. A theme-following QR is a broken QR.
- **The white plate under the mark is required.** The favicon is dark navy; without the plate it
  blends into surrounding dark modules.
- **Size scales with module count.** `qrDisplaySize(span, preferred)` treats `displaySize` as a
  floor and grows dense symbols toward a 320px cap, holding ~4 on-screen pixels per module. A long
  invite URL packs more modules into the same box; at a fixed 176px those modules drop below the
  legible threshold. This was found by decoding rendered output, not by inspection — a 280-char
  URL failed to decode at 176px and passes at the auto-sized 320px.
- **Exports are 1024px.** QR codes get reprinted on posters and slides, and upscaling a
  screen-sized capture is what makes them stop scanning.
- **The centre mark must be same-origin** (`/android-chrome-192x192.png`). A cross-origin image
  taints the canvas and both export paths fail.
- **Never log the URL.** On invite surfaces it carries a live single-use token, and the logger
  redacts by key name (`token`, `secret`, …), not by value — a full URL under the key `url` is
  emitted verbatim. Log a non-identifying discriminator instead.
- **`qrFileStem` keeps Unicode letters and digits.** An ASCII-only allowlist collapsed every
  non-Latin name to the same stem, so a cohort of `invite-李伟`, `invite-陈静`, … all downloaded as
  `conquest-invite.png` and silently overwrote each other. Path separators, dots, and control
  characters are neither letters nor digits, so traversal is still closed.

## Behaviour notes

- **Collapsed by default.** Most admins are pasting the link into an email, not holding a phone to
  the screen; an always-on code would push the surrounding form around for the majority.
- **Copy image degrades to download.** `ClipboardItem` support is probed after mount (never during
  render — it doesn't exist on the server, and branching on it inline causes a hydration mismatch).
  Where the clipboard is unsupported or denied, the action saves the file instead, so the user is
  still left holding the image.
- **Unencodable input renders nothing.** An empty URL, or one beyond QR capacity at level H, makes
  `LinkQrCode` return `null` rather than an error surface — the link itself is still copyable.

## Verifying a change

Unit tests cover the matrix, path, geometry, and sizing (`tests/unit/lib/app/qr/qr-matrix.test.ts`),
the rasterisation and clipboard/download paths (`…/render-qr-png.test.ts`), the component's actions
and failure modes (`tests/unit/components/app/qr/link-qr-code.test.tsx`), and the toggles on both
consuming surfaces (`…/questionnaires/copy-link-field.test.tsx`, `…/cohorts/round-invites-panel.test.tsx`).

The matrix tests assert structural invariants — spec-legal sizing, finder patterns, quiet zone,
path-round-trips-matrix — rather than a golden bitmap, because the encoder's mask-pattern choice is
version-dependent. The rasterisation tests run against a stub 2D context (the test DOM provides
neither a real one nor `Path2D`) and assert the geometry the module computes, not that a spy fired.

What unit tests cannot tell you is whether the thing actually scans. If you change the logo size,
the error-correction level, or the sizing rule, render real output and decode it with an
independent decoder (`jsqr` against `sharp`-extracted raw RGBA works; note that reading pixels back
via `@napi-rs/canvas`'s `getImageData` does **not** — it silently fails to decode even a valid
reference PNG).
