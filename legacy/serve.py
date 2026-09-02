#!/usr/bin/env python3
"""
ClipForge v6 — local dev server.

Why this exists:
  FFmpeg.wasm's multi-threaded core uses SharedArrayBuffer, which browsers only
  enable when the page is served with "cross-origin isolation" headers:
      Cross-Origin-Opener-Policy:   same-origin
      Cross-Origin-Embedder-Policy: require-corp

  Opening index.html with file:// or a plain `python -m http.server` will work,
  but FFmpeg will fall back to the slower single-thread build.

Usage:
    python serve.py
    # then open  http://localhost:8000  in your browser.
"""
import http.server, socketserver, sys

PORT = 8000

class COIHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy',   'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        # Disable cache so reloads pick up new code immediately
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    if len(sys.argv) > 1:
        try: PORT = int(sys.argv[1])
        except ValueError: pass
    with socketserver.TCPServer(('', PORT), COIHandler) as httpd:
        print(f'ClipForge dev server  →  http://localhost:{PORT}')
        print('Cross-origin isolation headers are ON (FFmpeg.wasm multi-thread enabled).')
        print('Ctrl-C to stop.')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nstopped.')