import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { isValidJobId } from '@/lib/jobs';
import { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, extensionOf } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/blob-upload - issue a one-shot token for a direct browser upload.
 *
 * This is what makes large clips possible on Vercel. A serverless function caps
 * its request body at roughly 4.5MB, so routing a 300MB clip through the server
 * is not merely slow, it is impossible. Instead the browser asks for a
 * short-lived token here and streams the file straight to Blob storage; the
 * bytes never touch a function.
 *
 * The token is scoped to a single pathname, so it cannot be reused to write
 * anywhere else in the store.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,

      onBeforeGenerateToken: async (pathname) => {
        // pathname is chosen by the client, so it has to be validated rather
        // than trusted: confirm it addresses a real job and an allowed kind.
        const match = pathname.match(/^jobs\/([0-9a-f-]{36})\/(clips\/[^/]+|voiceover[^/]*)$/i);
        if (!match || !isValidJobId(match[1])) {
          throw new Error('That upload path is not allowed.');
        }

        const ext = extensionOf(pathname);
        const isVoiceover = match[2].startsWith('voiceover');
        const allowed = isVoiceover ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS;
        if (ext && !allowed.has(ext)) {
          throw new Error(`"${ext}" is not a supported ${isVoiceover ? 'audio' : 'video'} format.`);
        }

        return {
          allowedContentTypes: isVoiceover
            ? ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/ogg', 'audio/flac', 'application/octet-stream']
            : ['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm', 'video/x-msvideo', 'application/octet-stream'],
          addRandomSuffix: false,
          allowOverwrite: true,
          maximumSizeInBytes: 1024 * 1024 * 1024,
        };
      },

      // Fired by Blob after the upload lands. It cannot reach a localhost dev
      // server, which is why the client also calls /register explicitly; that
      // path is idempotent, so a duplicate notification is harmless.
      onUploadCompleted: async () => {},
    });

    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Upload could not be authorised.' },
      { status: 400 },
    );
  }
}
