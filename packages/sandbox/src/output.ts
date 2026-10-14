/** Default bound for each of stdout, stderr and the preview log, in characters. */
export const DEFAULT_MAX_OUTPUT_CHARS = 64_000;

/**
 * Keeps the last `max` characters of `text` (errors are usually at the end), prefixed with a
 * marker saying how much was dropped.
 */
export function truncateTail(text: string, max: number = DEFAULT_MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `[... ${dropped} characters truncated ...]\n${text.slice(dropped)}`;
}
