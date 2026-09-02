import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ClipForge - subtitle-accurate video assembly',
  description:
    'Upload an SRT, your clips and a voiceover. Every clip is cut to the exact moment its character is named.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
