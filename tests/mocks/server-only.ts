/**
 * Test stub for the `server-only` package.
 *
 * The real `server-only` module throws on import unless the bundler applies React's `react-server`
 * export condition (Server Components / route handlers). Vitest doesn't, so importing any module that
 * does `import 'server-only'` would throw. Aliasing it here to an empty module lets server-only
 * modules be unit-tested directly — the build-time boundary guarantee still holds in the real Next
 * build, which is where it matters.
 */

export {};
