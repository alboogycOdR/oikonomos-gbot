import type { Config } from "tailwindcss";

// TASK-107 (Chat-1c): Tailwind v4 config. Content globs are scoped to the
// files that actually exist today (index.html + src/**) — this is a
// dashboard-wide config file (shared surface per spec §6's territory
// note), but only chat components are being styled with it in this task;
// TASK-108 (Chat-1d) will start using it for the routing/pages files too.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Dark, chrome-like desktop palette matching the Grok Bot
        // reference screenshot (spec §2). "chrome" = the sidebar/panel
        // chrome color, "surface" = conversation pane background.
        chrome: {
          DEFAULT: "#111318",
          panel: "#171a21",
          border: "#262b36",
        },
        surface: {
          DEFAULT: "#0d0f14",
          raised: "#1c202b",
        },
        bubble: {
          user: "#2563eb",
          bot: "#1f2430",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
