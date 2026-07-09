/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker deployments
  output: 'standalone',

  // Strict mode for React
  reactStrictMode: true,

  // Prevent Next.js from bundling Prisma's WASM query compiler.
  // Without this, Turbopack/webpack breaks the WASM module loading.
  // `ioredis` is an optional peer dep loaded lazily by the Redis rate-limit
  // store; marking it external silences the "Module not found" warning when
  // it isn't installed (the runtime try/catch already handles absence).
  // `@opentelemetry/api` is the same pattern — opt-in tracer dep loaded
  // lazily by `lib/orchestration/tracing/otel-bootstrap.ts`.
  // `pdf-parse` wraps `pdfjs-dist`, which loads its worker via a runtime
  // `import('./pdf.worker.mjs')`. Bundling it (Turbopack chunks) or tracing it
  // (Vercel NFT) can't follow that variable specifier, so the worker file goes
  // missing and PDF uploads fail with "Setting up fake worker failed: Cannot
  // find module …/pdf.worker.mjs". Marking both external keeps them in
  // node_modules; `pdf-parser.ts` then statically registers the worker on
  // `globalThis.pdfjsWorker` so the file is traced and the fallback is skipped.
  serverExternalPackages: [
    '@prisma/client',
    '@prisma/adapter-pg',
    'ioredis',
    '@opentelemetry/api',
    'pdf-parse',
    'pdfjs-dist',
    // Native canvas backend. `pdf-parser.ts` imports it to polyfill the
    // `DOMMatrix`/`Path2D`/`ImageData` globals pdfjs-dist needs in Node.
    // It ships platform-specific `.node` binaries that must not be bundled.
    '@napi-rs/canvas',
  ],

  // Security headers
  async headers() {
    return [
      {
        // Embed widget routes — allow framing and cross-origin access
        source: '/api/v1/embed/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

// Bundle analyzer (opt-in via `ANALYZE=true npm run build`). Used to pin which client chunk pulls
// an `eval`/`new Function` dependency that prod CSP (`script-src` without `'unsafe-eval'`) blocks —
// e.g. Next's `vm-browserify` fallback dragged in by a client module importing Node `crypto`/`vm`.
// Guarded require so the config never breaks if the dev dependency isn't installed.
// See .context/security/overview.md.
let withBundleAnalyzer = (config) => config;
if (process.env.ANALYZE === 'true') {
  try {
    withBundleAnalyzer = require('@next/bundle-analyzer')({ enabled: true });
  } catch {
    // eslint-disable-next-line no-console -- build-time config diagnostic, no logger available here
    console.warn(
      '[next.config] ANALYZE=true but @next/bundle-analyzer is not installed; skipping.'
    );
  }
}

module.exports = withBundleAnalyzer(nextConfig);
