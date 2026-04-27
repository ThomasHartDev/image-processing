/**
 * Error thrown when input bytes exceed the configured cap (default 50MB).
 *
 * Why: stress testing in apps/pixel-wand/docs/stress-report-2026-04.md showed
 * an 8MB AVIF input ballooning to 2.4GB RSS during decode, and a 30MB PNG
 * timing out at 30s with 1.5GB RSS. We need a hard byte cap before any sharp
 * work begins to prevent OOM kills.
 */
export class InputTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(
      `Input is ${bytes} bytes, exceeds maximum allowed ${maxBytes} bytes`,
    );
    this.name = "InputTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
    // Restore prototype chain when transpiled to ES5; harmless under ES2020+.
    Object.setPrototypeOf(this, InputTooLargeError.prototype);
  }
}

/**
 * Error thrown when input pixel dimensions exceed the configured cap.
 *
 * Why: even a small file (a few hundred KB) can have astronomical pixel
 * dimensions if it's heavily compressed (e.g. AVIF). The full SSIM search
 * decodes the buffer multiple times — at 12000x12000 each decode is roughly
 * 576MB of raw RGBA data, which kills the worker before we can recover.
 *
 * AVIF decode amplification is much worse than other formats, so AVIF
 * inputs get a tighter pixel cap (default 8000x8000).
 */
export class InputTooLargeDimensionsError extends Error {
  readonly width: number;
  readonly height: number;
  readonly maxPixels: number;
  readonly format: string | undefined;

  constructor(
    width: number,
    height: number,
    maxPixels: number,
    format: string | undefined,
  ) {
    super(
      `Input is ${width}x${height} (${width * height} px), exceeds maximum allowed ${maxPixels} px`,
    );
    this.name = "InputTooLargeDimensionsError";
    this.width = width;
    this.height = height;
    this.maxPixels = maxPixels;
    this.format = format;
    Object.setPrototypeOf(this, InputTooLargeDimensionsError.prototype);
  }
}
