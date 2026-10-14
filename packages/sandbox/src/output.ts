/** Default bound for each of stdout, stderr and the preview log, in characters. */
export const DEFAULT_MAX_OUTPUT_CHARS = 64_000;

/**
 * Collects a stream's output while holding at most about `2 * max` characters, so a command that
 * prints gigabytes cannot exhaust the backend's memory. Bytes are decoded leniently (invalid
 * UTF-8 becomes U+FFFD instead of throwing).
 */
export class TailBuffer {
  private readonly max: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private text = "";
  private dropped = 0;

  constructor(max: number = DEFAULT_MAX_OUTPUT_CHARS) {
    this.max = max;
  }

  push(chunk: string | Uint8Array): void {
    this.text += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.text.length > 2 * this.max) {
      const cut = this.text.length - this.max;
      this.dropped += cut;
      this.text = this.text.slice(cut);
    }
  }

  /** The tail, with a marker counting every character dropped since the start. */
  toString(): string {
    const text = this.text + this.decoder.decode();
    const total = this.dropped + text.length;
    if (total <= this.max) return text;
    const dropped = total - this.max;
    return `[... ${dropped} characters truncated ...]\n${text.slice(text.length - this.max)}`;
  }
}

/**
 * Keeps the last `max` characters of `text` (errors are usually at the end), prefixed with a
 * marker saying how much was dropped.
 */
export function truncateTail(text: string, max: number = DEFAULT_MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `[... ${dropped} characters truncated ...]\n${text.slice(dropped)}`;
}
