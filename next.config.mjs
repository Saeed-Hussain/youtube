/** @type {import('next').NextConfig} */
const nextConfig = {
  // Uploads are streamed to disk by the route handlers rather than going
  // through the body parser, so no body-size limit needs raising here.
  eslint: { ignoreDuringBuilds: true },

  // Tracing walks node_modules writing thousands of small files under .next.
  // Rooting it at the project keeps that walk from climbing above the repo,
  // and excluding the media directories keeps uploaded video and test fixtures
  // out of it entirely.
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    '*': ['.data/**', 'tests/e2e/media/**', 'legacy/**'],
  },
};

export default nextConfig;
