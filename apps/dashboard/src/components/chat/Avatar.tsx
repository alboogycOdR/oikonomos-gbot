// TASK-107 (Chat-1c): initials-on-color avatar (spec §2 "avatar-by-initials
// is enough for v1; no image upload required yet").
const PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#059669",
  "#d97706",
  "#dc2626",
  "#0891b2",
];

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
}

export function Avatar({ seed, name, size = "md" }: AvatarProps) {
  const color = PALETTE[hashSeed(seed) % PALETTE.length];
  const dimension = size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";
  return (
    <span
      role="img"
      aria-label={`${name} avatar`}
      className={`inline-flex ${dimension} shrink-0 select-none items-center justify-center rounded-full font-semibold text-white`}
      style={{ backgroundColor: color }}
    >
      {initialsOf(name)}
    </span>
  );
}
