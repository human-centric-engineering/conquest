/**
 * Vite plugin: stub `next/font/google` and `next/font/local` under Vitest.
 *
 * ## Why this exists
 *
 * Font loaders are transformed away by the Next compiler at build time — the
 * real `next/font/google/index.js` is an EMPTY file. Under Vitest there is no
 * compiler, so calling a loader throws `X is not a function`, and because
 * loaders are invoked at MODULE SCOPE:
 *
 *     const display = Fraunces({ subsets: ['latin'], variable: '--font-display' });
 *
 * the throw happens at import time. Any test importing a page or layout that
 * uses a custom font then fails before a single assertion runs — including
 * tests with nothing to do with fonts — and the error points nowhere near the
 * cause. Base Sunrise loads no custom font, so this is pre-emptive: a root
 * layout with brand typography is one of the first things a fork adds.
 *
 * ## Why a plugin rather than `vi.mock` in tests/setup.ts
 *
 * The stub has to answer for ANY loader name, because we cannot know which
 * fonts a fork picks — and `tests/setup.ts` is a platform file, so every fork
 * edit to it is a merge conflict. Two simpler shapes were tried and do not
 * work:
 *
 *  - A `vi.mock` factory returning a `Proxy`. Vitest spreads the factory result
 *    into a fixed namespace, so an open-ended Proxy collapses to `{}` and every
 *    named import fails with "No X export is defined on the mock".
 *  - A CJS `Proxy` module behind `resolve.alias`. Vite's interop computes the
 *    named-export list from the target's own keys, so unlisted names are again
 *    undefined.
 *
 * ESM named imports need a concrete export list at namespace-construction time,
 * so the list must be enumerated. Rather than hardcoding fonts (which is
 * exactly the maintenance burden forks were carrying), we DERIVE the names from
 * Next's own type declarations — the same list the compiler honours — so it
 * tracks Next upgrades and covers whatever font a fork chooses.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Where Next declares one `export declare function <FontName>` per font. */
const NEXT_GOOGLE_DTS = 'next/dist/compiled/@next/font/dist/google/index.d.ts';

/**
 * Minimal fallback if Next's internal layout changes. Not a maintained font
 * list — just enough that the stub keeps loading and the failure is a missing
 * font name rather than a broken module.
 */
const FALLBACK_FONTS = ['Inter', 'Roboto', 'Open_Sans', 'Lato', 'Montserrat'];

/** The handle shape a Next font loader returns, as module source. */
const HANDLE_SOURCE =
  "() => ({ className: 'mock-font', variable: '--mock-font', style: { fontFamily: 'mock' } })";

let cachedNames: string[] | undefined;

/** Parse the Google font loader names out of Next's shipped declarations. */
function googleFontNames(root: string): string[] {
  if (cachedNames) return cachedNames;
  try {
    const dts = readFileSync(path.join(root, 'node_modules', NEXT_GOOGLE_DTS), 'utf8');
    const names = [...dts.matchAll(/export declare function ([A-Za-z_][A-Za-z0-9_]*)/g)].map(
      (m) => m[1]
    );
    cachedNames = names.length > 0 ? [...new Set(names)] : FALLBACK_FONTS;
  } catch {
    cachedNames = FALLBACK_FONTS;
  }
  return cachedNames;
}

/**
 * Serves stub modules for the two `next/font` entrypoints. Google gets one
 * named export per font; local gets a default export (`localFont(...)`).
 */
export function nextFontStub(): Plugin {
  const GOOGLE = '\0sunrise:next-font-google';
  const LOCAL = '\0sunrise:next-font-local';
  let root = process.cwd();

  return {
    name: 'sunrise:next-font-stub',
    // Must beat Vite's own node resolution, which would otherwise hand back
    // Next's empty `index.js` and leave every loader import bound to undefined.
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === 'next/font/google') return GOOGLE;
      if (id === 'next/font/local') return LOCAL;
      return null;
    },
    load(id) {
      if (id === LOCAL) return `export default ${HANDLE_SOURCE};`;
      if (id === GOOGLE) {
        const decls = googleFontNames(root)
          .map((name) => `export const ${name} = ${HANDLE_SOURCE};`)
          .join('\n');
        // `default` too, so a namespace import or an interop default still works.
        return `${decls}\nexport default ${HANDLE_SOURCE};\n`;
      }
      return null;
    },
  };
}
