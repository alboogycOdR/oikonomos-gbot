// TASK-107 (Chat-1c): initials-on-color avatar (spec §2 "avatar-by-initials
// is enough for v1; no image upload required yet").
import type { CSSProperties } from "react";

export const avatarColorTokens = ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink"] as const;
export const avatarShapeTokens = ["circle", "square", "rounded", "hexagon", "diamond", "star", "triangle", "teardrop"] as const;
export type AvatarColorToken = (typeof avatarColorTokens)[number];
export type AvatarShapeToken = (typeof avatarShapeTokens)[number];

export const avatarColors: Record<AvatarColorToken, string> = {
  red: "#ef4444", orange: "#f97316", amber: "#f59e0b", yellow: "#eab308", lime: "#84cc16", green: "#22c55e",
  teal: "#14b8a6", cyan: "#06b6d4", blue: "#3b82f6", indigo: "#6366f1", violet: "#8b5cf6", pink: "#ec4899",
};
const PALETTE = avatarColorTokens.map((token) => avatarColors[token]);
const clipPathByShape: Partial<Record<AvatarShapeToken, string>> = {
  hexagon: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
  diamond: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
  star: "polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)",
  triangle: "polygon(50% 0, 100% 100%, 0 100%)",
  teardrop: "polygon(50% 0, 77% 32%, 88% 61%, 77% 88%, 50% 100%, 23% 88%, 12% 61%, 23% 32%)",
};

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export interface AvatarProps {
  seed: string;
  name: string;
  size?: "sm" | "md";
  avatarColor?: AvatarColorToken | null;
  avatarShape?: AvatarShapeToken | null;
}

function avatarStyle(seed: string, avatarColor?: AvatarColorToken | null, avatarShape?: AvatarShapeToken | null): CSSProperties {
  const shape = avatarShape ?? "circle";
  return {
    backgroundColor: avatarColor == null ? PALETTE[hashSeed(seed) % PALETTE.length] : avatarColors[avatarColor],
    borderRadius: shape === "circle" ? "50%" : shape === "rounded" ? "25%" : undefined,
    clipPath: clipPathByShape[shape],
  };
}

export function Avatar({ seed, name, size = "md", avatarColor, avatarShape }: AvatarProps) {
  const dimension = size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
  return (
    <span
      role="img"
      aria-label={`${name} avatar`}
      data-avatar-color={avatarColor ?? "derived"}
      data-avatar-shape={avatarShape ?? "circle"}
      className={`inline-flex ${dimension} shrink-0 select-none items-center justify-center font-semibold text-white`}
      style={avatarStyle(seed, avatarColor, avatarShape)}
    >
      {initialsOf(name)}
    </span>
  );
}
