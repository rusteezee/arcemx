import { cn } from "@/lib/utils";

interface MoodPillProps {
  mood?: string | null;
  size?: "sm" | "md" | "lg";
}

export function MoodPill({ mood, size = "md" }: MoodPillProps) {
  const m = (mood || "neutral").toLowerCase();
  const map: Record<string, string> = {
    bull: "pill-gain",
    bear: "pill-loss",
    neutral: "pill-warn",
  };
  const sizes: Record<string, string> = {
    sm: "text-[0.65rem] px-2 py-0.5",
    md: "",
    lg: "text-sm px-3 py-1",
  };
  const glyphs: Record<string, string> = { bull: "↑", bear: "↓", neutral: "→" };

  return (
    <span className={cn("pill", map[m] || "", sizes[size] || "")}>
      <span className="glyph !text-current !opacity-100 text-[0.85em]">{glyphs[m]}</span>
      {m.toUpperCase()}
    </span>
  );
}
