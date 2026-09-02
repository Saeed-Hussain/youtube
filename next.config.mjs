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

  // The FFmpeg binary is resolved at runtime, so tracing cannot see it and
  // would leave it out of the deployed bundle - which is the whole reason
  // rendering works on a host with nothing installed. Naming it here forces
  // its inclusion for the routes that shell out to it.
  outputFileTracingIncludes: {
    '/api/jobs/[id]/render/step': ['./node_modules/ffmpeg-static/**'],
    '/api/jobs/[id]/render': ['./node_modules/ffmpeg-static/**'],
    '/api/jobs/[id]/register': ['./node_modules/ffmpeg-static/**'],
    '/api/system': ['./node_modules/ffmpeg-static/**'],
  },

  // Keep everything that is not needed at runtime out of the bundle: the
  // 250MB function limit is genuinely tight once an 80MB binary is inside it.
  outputFileTracingExcludes: {
    '*': [
      '.data/**',
      'tests/**',
      'legacy/**',
      'node_modules/@swc/**',
      'node_modules/esbuild/**',
      'node_modules/terser/**',
      'node_modules/typescript/**',
    ],
  },
};

export default nextConfig;
