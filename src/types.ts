export type ImageFormat = "webp" | "avif" | "jpeg" | "png" | "gif" | "tiff" | "heif";
export type OptimizationLevel = "auto" | "maximum-compression" | "maximum-quality" | "custom";

export interface OptimizationOptions {
  format: ImageFormat;
  level: OptimizationLevel;
  customQuality?: number;
  customTargetSizeKB?: number; // For custom mode: target file size in KB
  // Optional dimension constraints. Only scales DOWN (never upsizes).
  // When both maxWidth and maxHeight are provided:
  //   preserveAspect=true  (default) — fit inside the box, keeping aspect ratio
  //   preserveAspect=false           — clamp each dimension independently (fill/stretch)
  maxWidth?: number;
  maxHeight?: number;
  preserveAspect?: boolean;
  // Hard input-size cap in bytes. Default 50MB. Throws InputTooLargeError
  // before any sharp work happens. Per-call overridable so admins can lift it.
  maxInputBytes?: number;
  // Hard pixel cap (width * height). Default 12000 * 12000 = 144M pixels.
  // Checked from sharp metadata BEFORE the SSIM search runs.
  maxPixels?: number;
  // Tighter pixel cap applied only when input is AVIF/HEIF, where decode
  // amplification is much worse. Default 8000 * 8000 = 64M pixels.
  maxAvifPixels?: number;
}

/**
 * Default hard byte cap. 50MB. See errors.ts for rationale.
 */
export const DEFAULT_MAX_INPUT_BYTES = 50 * 1024 * 1024;

/**
 * Default pixel cap. 12000 * 12000 = 144M pixels. Generous enough for almost
 * any real photo (44MP is a high-end camera) but blocks the 30000x30000
 * adversarial inputs.
 */
export const DEFAULT_MAX_PIXELS = 12000 * 12000;

/**
 * Tighter pixel cap for AVIF/HEIF inputs. 8000 * 8000 = 64M pixels. AVIF
 * decode allocates roughly 4x more RAM per pixel than JPEG/PNG due to
 * yuv-to-rgba conversion plus tile reassembly, so the same pixel count
 * costs much more memory.
 */
export const DEFAULT_MAX_AVIF_PIXELS = 8000 * 8000;

export interface OptimizationResult {
  buffer: Buffer;
  quality: number;
  ssim: number;
  originalSize: number;
  optimizedSize: number;
  savings: string;
  format: ImageFormat;
}

// Format-specific quality ranges based on research
export const FORMAT_QUALITY_RANGES: Record<
  ImageFormat,
  { min: number; max: number; default: number }
> = {
  webp: { min: 1, max: 95, default: 82 },
  avif: { min: 1, max: 95, default: 64 },
  jpeg: { min: 1, max: 95, default: 80 },
  png: { min: 1, max: 100, default: 85 }, // PNG now supports lossy compression (1-79) and lossless (80-100)
  gif: { min: 1, max: 100, default: 80 },
  tiff: { min: 1, max: 100, default: 80 },
  heif: { min: 1, max: 95, default: 50 },
};

// Target SSIM thresholds for different optimization levels
// Note: Modern codecs (WebP, AVIF) can achieve 0.99+ SSIM even at very low quality
// So we need high thresholds and quality floors to ensure good visual results
export const SSIM_TARGETS: Record<OptimizationLevel, number> = {
  auto: 0.995, // Excellent quality - raised significantly to prevent quality=1
  "maximum-compression": 0.985, // Good quality - raised to ensure quality >5
  "maximum-quality": 0.9995, // Near-perfect quality
  custom: 0.995, // Default to auto
};

// Minimum quality levels regardless of SSIM (prevents extremely low quality)
export const MIN_QUALITY_FLOOR: Record<OptimizationLevel, Record<ImageFormat, number>> = {
  auto: { webp: 20, avif: 15, jpeg: 25, png: 25, gif: 50, tiff: 50, heif: 20 },
  "maximum-compression": { webp: 10, avif: 8, jpeg: 15, png: 15, gif: 30, tiff: 30, heif: 10 },
  "maximum-quality": { webp: 75, avif: 65, jpeg: 75, png: 75, gif: 80, tiff: 80, heif: 70 },
  custom: { webp: 20, avif: 15, jpeg: 25, png: 25, gif: 50, tiff: 50, heif: 20 }, // Same as auto for custom
};
