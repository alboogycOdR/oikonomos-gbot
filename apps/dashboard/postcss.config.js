// TASK-107 (Chat-1c): Tailwind v4's PostCSS plugin. Vite picks up this
// file automatically for any CSS it processes (build or dev) — no
// vite.config.ts change needed, keeping this task's territory to
// apps/dashboard/{tailwind.config.ts,postcss.config.js,src/index.css,
// src/components/chat/**} only.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
