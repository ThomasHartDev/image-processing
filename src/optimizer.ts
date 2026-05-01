import sharp from "sharp";
import { encodeImage } from "./encode";
import { InputTooLargeDimensionsError, InputTooLargeError } from "./errors";
import { calculatePerceptualScore } from "./perceptual";
import { calculateSSIM } from "./ssim";
import {
  DEFAULT_MAX_AVIF_PIXELS,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_PIXELS,
  FORMAT_QUALITY_RANGES,
  MIN_QUALITY_FLOOR,
  SSIM_TARGETS,
  type ImageFormat,
  type OptimizationLevel,
  type OptimizationOptions,
  type OptimizationResult,
} from "./types";

/**
 * Score one candidate output against the working buffer.
 * In "perceptual" mode this uses MS-SSIM (ms-ssim-5scale), which correlates
 * better with human perception. In every other mode it uses single-scale SSIM
 * to preserve existing behavior bit-for-bit.
 *
 * Error handling note: BOTH scorers swallow internal errors and return a low
 * fallback score so the binary search treats a failed encode/decode as "this
 * quality didn't work" and tries another, instead of bubbling the error and
 * aborting the whole optimization. The fallback values differ for legacy
 * reasons: calculateSSIM returns 0.95 (a near-acceptance for some legacy
 * thresholds but a rejection for the perceptual 0.985 threshold);
 * calculatePerceptualScore returns 0 (clear rejection in every mode).
 * Treat both as "unsuitable quality" and move on.
 */
async function scoreCandidate(
  reference: Buffer,
  candidate: Buffer,
  level: OptimizationLevel,
): Promise<number> {
  if (level === "perceptual") {
    const result = await calculatePerceptualScore(reference, candidate);
    return result.score;
  }
  return calculateSSIM(reference, candidate);
}

/**
 * Apply optional dimension constraints to the input buffer BEFORE the SSIM search runs.
 * Only downsizes — withoutEnlargement ensures a 100x100 input with maxWidth=500 stays 100x100.
 * Returns the original buffer untouched when neither maxWidth nor maxHeight is provided.
 */
async function applyResize(
  inputBuffer: Buffer,
  maxWidth: number | undefined,
  maxHeight: number | undefined,
  preserveAspect: boolean,
): Promise<Buffer> {
  if (maxWidth === undefined && maxHeight === undefined) {
    return inputBuffer;
  }

  // preserveAspect=true  → fit inside the box, aspect ratio kept
  // preserveAspect=false → clamp each dimension independently (fill, no enlargement)
  const fit = preserveAspect ? "inside" : "fill";

  return sharp(inputBuffer)
    .resize(maxWidth ?? null, maxHeight ?? null, { fit, withoutEnlargement: true })
    .toBuffer();
}

/**
 * Find optimal quality using binary search with a quality-score threshold.
 * The metric used depends on the level: every level except "perceptual" uses
 * single-scale SSIM (existing behavior, unchanged). "perceptual" uses
 * MS-SSIM (ms-ssim-5scale) which correlates better with human perception and
 * lets the search push compression harder at the same perceived quality.
 *
 * The `ssim` field in the return value carries whichever score was used.
 * The field name is kept for API stability with callers that have been
 * reading it since v0.1. Read SSIM_TARGETS[level] to know what scale the
 * value is on.
 */
export async function findOptimalQuality(
  inputBuffer: Buffer,
  format: ImageFormat,
  targetSSIM: number,
  level: OptimizationLevel,
): Promise<{ quality: number; ssim: number; buffer: Buffer }> {
  const qualityRange = FORMAT_QUALITY_RANGES[format];

  // Get quality floor for this optimization level
  const qualityFloor = MIN_QUALITY_FLOOR[level]?.[format] || qualityRange.min;

  let minQuality = Math.max(qualityRange.min, qualityFloor);
  let maxQuality = qualityRange.max;

  // Special handling for PNG in maximum-quality mode
  // Use lossy high-quality (75-79) instead of lossless (80+) to avoid expansion when converting from lossy formats
  if (format === "png" && level === "maximum-quality") {
    maxQuality = 79; // Force lossy mode for PNG max quality to prevent file expansion
  }

  let bestQuality = maxQuality;
  let bestBuffer: Buffer | null = null;
  let bestSSIM = 0;

  let iteration = 0;
  const MAX_ITERATIONS = 10; // Increased from 8 for better search

  // Binary search for optimal quality
  while (maxQuality - minQuality > 2 && iteration < MAX_ITERATIONS) {
    iteration++;
    const midQuality = Math.floor((minQuality + maxQuality) / 2);

    // Encode at mid quality
    const compressed = await encodeImage(inputBuffer, format, midQuality);

    // Score against the target metric (perceptual or single-scale SSIM)
    const ssimValue = await scoreCandidate(inputBuffer, compressed, level);

    if (ssimValue >= targetSSIM) {
      // Quality is good enough, try lower quality for better compression
      bestQuality = midQuality;
      bestSSIM = ssimValue;
      bestBuffer = compressed;
      maxQuality = midQuality - 1;
    } else {
      // Quality too low, need higher quality
      minQuality = midQuality + 1;
    }
  }

  // Test remaining qualities in the narrow range
  for (let q = minQuality; q <= maxQuality; q++) {
    const testBuffer = await encodeImage(inputBuffer, format, q);
    const testSSIM = await scoreCandidate(inputBuffer, testBuffer, level);

    if (testSSIM >= targetSSIM) {
      // Found a valid quality, use the lowest one that meets threshold
      if (!bestBuffer || q < bestQuality) {
        bestQuality = q;
        bestSSIM = testSSIM;
        bestBuffer = testBuffer;
      }
    }
  }

  // Ensure we don't go below the quality floor, even if SSIM is met
  if (bestQuality < qualityFloor) {
    bestQuality = qualityFloor;

    // For PNG max-quality, ensure we don't exceed 79 (to avoid lossless expansion)
    if (format === "png" && level === "maximum-quality" && bestQuality > 79) {
      bestQuality = 79;
    }

    bestBuffer = await encodeImage(inputBuffer, format, bestQuality);
    bestSSIM = await scoreCandidate(inputBuffer, bestBuffer, level);
  }

  // Safety check: if somehow bestBuffer is still null, use quality floor
  if (!bestBuffer) {
    bestQuality = Math.max(qualityFloor, qualityRange.default);
    bestBuffer = await encodeImage(inputBuffer, format, bestQuality);
    bestSSIM = await scoreCandidate(inputBuffer, bestBuffer, level);
  }

  return {
    quality: bestQuality,
    ssim: bestSSIM,
    buffer: bestBuffer,
  };
}

/**
 * Find optimal quality using binary search to achieve target file size
 * Prioritizes HIGHER quality when multiple qualities achieve the target
 */
export async function findOptimalSizeKB(
  inputBuffer: Buffer,
  format: ImageFormat,
  targetSizeKB: number,
): Promise<{ quality: number; ssim: number; buffer: Buffer }> {
  const qualityRange = FORMAT_QUALITY_RANGES[format];
  const targetSizeBytes = targetSizeKB * 1024;
  let minQuality = qualityRange.min;
  let maxQuality = qualityRange.max;
  let bestQuality = qualityRange.min;
  let bestBuffer: Buffer | null = null;
  let bestSSIM = 0;
  let bestSizeDiff = Infinity;

  const testedQualities = new Map<number, { buffer: Buffer; size: number; ssim: number }>();

  // Binary search for optimal quality based on file size
  while (maxQuality - minQuality > 1) {
    const midQuality = Math.floor((minQuality + maxQuality) / 2);

    // Encode at mid quality
    const compressed = await encodeImage(inputBuffer, format, midQuality);
    const compressedSize = compressed.length;
    const ssimValue = await calculateSSIM(inputBuffer, compressed);

    // Store this result
    testedQualities.set(midQuality, { buffer: compressed, size: compressedSize, ssim: ssimValue });

    const sizeDiff = compressedSize - targetSizeBytes;

    // Update best if this is closer to target
    const absSizeDiff = Math.abs(sizeDiff);
    if (absSizeDiff < bestSizeDiff || (absSizeDiff === bestSizeDiff && midQuality > bestQuality)) {
      bestQuality = midQuality;
      bestBuffer = compressed;
      bestSSIM = ssimValue;
      bestSizeDiff = absSizeDiff;
    }

    if (compressedSize > targetSizeBytes) {
      // File too large, need lower quality
      maxQuality = midQuality - 1;
    } else {
      // File too small, try higher quality
      minQuality = midQuality + 1;
    }
  }

  // Test remaining qualities in range
  for (let q = minQuality; q <= maxQuality; q++) {
    if (!testedQualities.has(q)) {
      const buffer = await encodeImage(inputBuffer, format, q);
      const size = buffer.length;
      const ssim = await calculateSSIM(inputBuffer, buffer);

      testedQualities.set(q, { buffer, size, ssim });

      const sizeDiff = size - targetSizeBytes;
      const absSizeDiff = Math.abs(sizeDiff);

      // Prioritize HIGHER quality when size difference is equal
      if (absSizeDiff < bestSizeDiff || (absSizeDiff === bestSizeDiff && q > bestQuality)) {
        bestQuality = q;
        bestBuffer = buffer;
        bestSSIM = ssim;
        bestSizeDiff = absSizeDiff;
      }
    }
  }

  // Among all tested qualities, find the one closest to target with highest quality
  for (const [quality, result] of testedQualities.entries()) {
    const sizeDiff = Math.abs(result.size - targetSizeBytes);
    if (sizeDiff < bestSizeDiff || (sizeDiff === bestSizeDiff && quality > bestQuality)) {
      bestQuality = quality;
      bestBuffer = result.buffer;
      bestSSIM = result.ssim;
      bestSizeDiff = sizeDiff;
    }
  }

  // Safety check
  if (!bestBuffer) {
    bestQuality = qualityRange.max;
    bestBuffer = await encodeImage(inputBuffer, format, bestQuality);
    bestSSIM = await calculateSSIM(inputBuffer, bestBuffer);
  }

  return {
    quality: bestQuality,
    ssim: bestSSIM,
    buffer: bestBuffer,
  };
}

/**
 * Optimize image with intelligent quality selection
 */
export async function optimizeImage(
  inputBuffer: Buffer,
  options: OptimizationOptions,
): Promise<OptimizationResult> {
  const {
    format,
    level,
    customQuality,
    customTargetSizeKB,
    maxWidth,
    maxHeight,
    preserveAspect = true,
    maxInputBytes = DEFAULT_MAX_INPUT_BYTES,
    maxPixels = DEFAULT_MAX_PIXELS,
    maxAvifPixels = DEFAULT_MAX_AVIF_PIXELS,
  } = options;

  // Guard 1: hard byte cap, checked BEFORE any sharp work. Prevents the
  // pathological "8MB AVIF -> 2.4GB RSS during decode" path documented in
  // apps/pixel-wand/docs/stress-report-2026-04.md from ever reaching sharp.
  if (inputBuffer.length > maxInputBytes) {
    throw new InputTooLargeError(inputBuffer.length, maxInputBytes);
  }

  // Guard 2: dimension probe via metadata-only read (no full decode).
  // failOn:'truncated' prevents sharp from silently accepting malformed inputs;
  // metadata() reads only the header chunks so RSS stays flat here.
  const probeMetadata = await sharp(inputBuffer, { failOn: "truncated" }).metadata();
  const probeWidth = probeMetadata.width ?? 0;
  const probeHeight = probeMetadata.height ?? 0;
  const probePixels = probeWidth * probeHeight;
  // sharp reports AVIF as either "heif" or "avif" depending on container; treat both as AVIF.
  const isAvif = probeMetadata.format === "heif" || probeMetadata.format === "avif";
  const effectivePixelCap = isAvif ? Math.min(maxPixels, maxAvifPixels) : maxPixels;
  if (probePixels > effectivePixelCap) {
    throw new InputTooLargeDimensionsError(
      probeWidth,
      probeHeight,
      effectivePixelCap,
      probeMetadata.format,
    );
  }

  // Original size is measured against the ORIGINAL input — not the resized buffer —
  // so the savings figure reflects real bytes saved from the caller's perspective.
  const originalSize = inputBuffer.length;

  // Resize up-front so SSIM compares the compressed output to the already-resized source.
  // Comparing against the full-size original would penalize a correctly-downscaled image.
  const workingBuffer = await applyResize(inputBuffer, maxWidth, maxHeight, preserveAspect);

  let optimizedBuffer: Buffer;
  let quality: number;
  let ssimValue: number;

  // Special handling for GIF (limited optimization)
  if (format === "gif") {
    // GIF has limited quality control, use default effort
    quality = FORMAT_QUALITY_RANGES[format].default;
    optimizedBuffer = await encodeImage(workingBuffer, format, quality);
    ssimValue = await calculateSSIM(workingBuffer, optimizedBuffer);
  } else if (level === "custom" && customTargetSizeKB !== undefined) {
    // Custom target size for lossy formats
    const result = await findOptimalSizeKB(workingBuffer, format, customTargetSizeKB);
    quality = result.quality;
    ssimValue = result.ssim;
    optimizedBuffer = result.buffer;
  } else if (level === "custom" && customQuality !== undefined) {
    // Use custom quality setting (backwards compatibility)
    quality = Math.max(
      FORMAT_QUALITY_RANGES[format].min,
      Math.min(customQuality, FORMAT_QUALITY_RANGES[format].max),
    );

    optimizedBuffer = await encodeImage(workingBuffer, format, quality);
    ssimValue = await calculateSSIM(workingBuffer, optimizedBuffer);
  } else {
    // Use intelligent optimization with target SSIM for lossy formats
    const targetSSIM = SSIM_TARGETS[level];
    const result = await findOptimalQuality(workingBuffer, format, targetSSIM, level);
    quality = result.quality;
    ssimValue = result.ssim;
    optimizedBuffer = result.buffer;
  }

  const optimizedSize = optimizedBuffer.length;
  const savings = ((1 - optimizedSize / originalSize) * 100).toFixed(1);

  return {
    buffer: optimizedBuffer,
    quality,
    ssim: ssimValue,
    originalSize,
    optimizedSize,
    savings: `${savings}%`,
    format,
  };
}

/**
 * Get format recommendations based on image characteristics
 */
export function getFormatRecommendation(
  hasTransparency: boolean,
  isPhoto: boolean,
): ImageFormat {
  if (hasTransparency) {
    // AVIF supports transparency and has better compression
    return "avif";
  }

  if (isPhoto) {
    // WebP offers excellent compression for photos with wide browser support
    return "webp";
  }

  // Default to WebP for most use cases
  return "webp";
}

// Re-export OptimizationLevel type so consumers can depend on it from this module.
export type { OptimizationLevel };
