import type { Config } from 'tailwindcss';

/**
 * Colours are defined once as CSS custom properties in `globals.css` and merely
 * surfaced to Tailwind here. Keeping a single source of truth means the raw
 * `var(--…)` used inside hand-written CSS and the `bg-surface-2` used in JSX can
 * never drift apart.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: {
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        line: {
          DEFAULT: 'var(--line)',
          soft: 'var(--line-soft)',
        },
        ink: {
          DEFAULT: 'var(--text)',
          dim: 'var(--text-dim)',
          faint: 'var(--text-faint)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          soft: 'var(--accent-soft)',
        },
        good: 'var(--good)',
        warn: 'var(--warn)',
        bad: 'var(--bad)',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SF Mono', 'Cascadia Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
