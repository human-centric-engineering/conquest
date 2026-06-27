/**
 * Rendering-surface classification (fork-owned).
 *
 * A pure string predicate shared by the proxy (server-side, sets the `x-surface`
 * header for the first paint) and `SurfaceSync` (client-side, keeps
 * `<html data-surface>` correct across App Router navigations) so the two can
 * never drift. `/admin` is the only non-consumer URL segment — route groups
 * don't affect the URL — so this single prefix classifies the whole app.
 *
 * Boundary-clean: no `next/*` imports, just a string check, so it's safe in the
 * middleware/edge runtime, on the client, and within the `lib/app/**` boundary.
 * To flip admin onto the consumer theme too, this is the one place to change.
 */
export type Surface = 'admin' | 'consumer';

export function classifySurface(pathname: string): Surface {
  return pathname.startsWith('/admin') ? 'admin' : 'consumer';
}
