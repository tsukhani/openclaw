/** Render a horizontal bar chart segment. Ratio is clamped to [0, 1]. */
export function bar(ratio: number, width: number = 16): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(clamped * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}
