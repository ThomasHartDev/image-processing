import sharp from "sharp";
import ssim from "ssim.js";

/**
 * Public name of the perceptual metric used by calculatePerceptualScore.
 * Callers can read this at runtime to know which library/algorithm scored
 * the comparison. See docs/decisions/perceptual-quality-metric.md for the
 * survey that picked MS-SSIM over butteraugli/ssimulacra2.
 */
export const PERCEPTUAL_METRIC_NAME = "ms-ssim-5scale";

/**
 * Score scale for ms-ssim-5scale: range [0, 1], higher is better, 1.0 = identical.
 * For reference, the human-eye "barely noticeable difference" band is roughly
 * 0.985 and up. SSIM-equivalent thresholds will read slightly lower here because
 * MS-SSIM penalizes multi-scale structural drift more aggressively than the
 * single-scale SSIM does.
 */
export const PERCEPTUAL_SCORE_RANGE = { min: 0, max: 1, identical: 1 } as const;

// MS-SSIM weights from Wang/Simoncelli/Bovik (2003), table 1, 5-scale variant.
// The published values sum to 1.0001 (rounding noise). Renormalize at module
// load so any direct reader sees properly-summing weights, and so the geometric
// mean produces results in [0, 1] without depending on per-call renormalization.
const RAW_WEIGHTS = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333];
const RAW_SUM = RAW_WEIGHTS.reduce((a, b) => a + b, 0);
const MS_SSIM_WEIGHTS: readonly number[] = RAW_WEIGHTS.map((w) => w / RAW_SUM);
const NUM_SCALES: number = MS_SSIM_WEIGHTS.length;

// Same 2000px cap as ssim.ts. Running the metric on a 24MP raw buffer adds
// ~10s of wall time and 1GB+ RSS without changing the score meaningfully.
// Human perception of compression artifacts is a low-frequency phenomenon.
const MAX_DIMENSION = 2000;

// MS-SSIM downsamples by 2x per scale. We require >= 64px on the smaller side
// at the source so the COMMON case can run at least 2 scales (64 -> 32).
// Inputs smaller than this fall back to fewer scales (1-scale fallback
// degrades to single-scale SSIM behavior, which is still a valid metric, just
// less perceptually-tuned). The per-scale loop also stops early once either
// dimension falls below MIN_SSIM_WINDOW so we never feed degenerate sizes
// (1x1, 2x1) into ssim.js.
const MIN_DIMENSION_FOR_SCALES = 64;

// Below this dimension a single SSIM window can't span the image, so the
// per-scale score becomes meaningless. We stop the multi-scale loop early when
// either current dimension falls below this and renormalize over the scales we
// did include.
const MIN_SSIM_WINDOW = 4;

/**
 * Convert a sharp result to the ImageData shape ssim.js expects.
 */
function toImageData(raw: Buffer, width: number, height: number) {
  return {
    data: new Uint8ClampedArray(raw),
    width,
    height,
  };
}

/**
 * Decode a buffer into raw RGBA pixels at the requested dimensions.
 * Both inputs in calculatePerceptualScore go through this so the comparison
 * runs on identical-sized raw buffers regardless of source format.
 */
async function decodeToRgba(
  buffer: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const result = await sharp(buffer)
    .resize(width, height, { fit: "fill" })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  return result.data;
}

/**
 * Downsample raw RGBA pixels by an integer factor using sharp's resize.
 * Returns the new pixel buffer plus its dimensions.
 */
async function downsampleRgba(
  raw: Buffer,
  width: number,
  height: number,
  factor: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  if (factor === 1) {
    return { data: raw, width, height };
  }
  const newWidth = Math.max(1, Math.floor(width / factor));
  const newHeight = Math.max(1, Math.floor(height / factor));
  const result = await sharp(raw, {
    raw: { width, height, channels: 4 },
  })
    .resize(newWidth, newHeight, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: result.data, width: result.info.width, height: result.info.height };
}

export interface PerceptualScoreResult {
  /** Score in [0, 1], higher = more perceptually similar, 1.0 = identical. */
  score: number;
  /** Algorithm name, currently always "ms-ssim-5scale". */
  metric: string;
  /** Working dimensions used for the comparison (post-resize-cap). */
  dimensions: { width: number; height: number };
}

/**
 * Compute perceptual similarity between an original buffer and a compressed
 * buffer. Uses 5-scale MS-SSIM to better predict human perception than
 * single-scale SSIM does at the same wall-time cost (about 1.31x because each
 * scale is 4x smaller in pixel count).
 *
 * Both inputs are resized to the SAME dimensions before scoring (the metric
 * requires identical dimensions). Inputs larger than 2000px on either axis
 * are scaled down to 2000px to keep wall time bounded.
 *
 * The score scale is [0, 1] with 1.0 = identical. The "barely noticeable"
 * threshold for the optimizer's perceptual mode is ~0.985; see
 * SSIM_TARGETS["perceptual"] in types.ts.
 *
 * Errors during scoring (sharp decode failure, ssim.js throw) are caught and
 * surfaced as score=0 plus a stderr log. This matches calculateSSIM's
 * silent-fallback behavior so the optimizer's binary search treats the failure
 * as "this quality didn't work" and tries another, instead of bubbling the
 * error and aborting the whole request. See scoreCandidate() in optimizer.ts
 * for the comment on the asymmetry.
 */
export async function calculatePerceptualScore(
  originalBuffer: Buffer,
  optimizedBuffer: Buffer,
): Promise<PerceptualScoreResult> {
  try {
    // Probe the original to decide on working dimensions. Both inputs get
    // resized to these dimensions so the comparison is apples-to-apples.
    const meta = await sharp(originalBuffer).metadata();
    const srcWidth = meta.width ?? 0;
    const srcHeight = meta.height ?? 0;

    if (srcWidth === 0 || srcHeight === 0) {
      throw new Error("calculatePerceptualScore: original buffer has zero dimensions");
    }

    const maxSide = Math.max(srcWidth, srcHeight);
    const scaleDownFactor = maxSide > MAX_DIMENSION ? MAX_DIMENSION / maxSide : 1;
    const workWidth = Math.max(1, Math.round(srcWidth * scaleDownFactor));
    const workHeight = Math.max(1, Math.round(srcHeight * scaleDownFactor));

    // Decode both inputs to identical-sized RGBA raw buffers.
    const [originalRaw, compressedRaw] = await Promise.all([
      decodeToRgba(originalBuffer, workWidth, workHeight),
      decodeToRgba(optimizedBuffer, workWidth, workHeight),
    ]);

    // If the working size is too small to do 5 scales, fall back to fewer scales.
    // This keeps the metric well-defined for edge cases (tiny avatars, icons).
    let usableScales = NUM_SCALES;
    let testDim = Math.min(workWidth, workHeight);
    for (let s = 0; s < NUM_SCALES; s++) {
      if (testDim < MIN_DIMENSION_FOR_SCALES) {
        usableScales = s;
        break;
      }
      testDim = Math.floor(testDim / 2);
    }
    if (usableScales === 0) usableScales = 1; // always run at least one scale

    // Run SSIM at each scale, accumulate scores. We combine using the geometric
    // mean form from Wang/Simoncelli/Bovik 2003: finalScore = product(s_i ^ w_i).
    // The arithmetic mean form (a previous implementation used it) is ALWAYS
    // greater than or equal to the geometric mean by Jensen's inequality, so it
    // would systematically inflate the score and let the optimizer accept
    // compression that the true MS-SSIM definition rejects.
    const scores: number[] = [];
    const completedDims: { width: number; height: number }[] = [];

    let currentOriginal = originalRaw;
    let currentCompressed = compressedRaw;
    let currentWidth = workWidth;
    let currentHeight = workHeight;

    for (let scale = 0; scale < usableScales; scale++) {
      // Stop early on extreme aspect ratios (e.g. 100x10) where one dimension
      // halves down to a degenerate size before the other. A SSIM window can't
      // span an image with a side smaller than MIN_SSIM_WINDOW, so the score
      // is meaningless and would unfairly drag the geometric mean.
      if (currentWidth < MIN_SSIM_WINDOW || currentHeight < MIN_SSIM_WINDOW) {
        break;
      }

      const result = ssim(
        toImageData(currentOriginal, currentWidth, currentHeight),
        toImageData(currentCompressed, currentWidth, currentHeight),
      );

      // SSIM can return values slightly outside [0, 1] for pathological inputs;
      // clamp so the combined score stays well-defined.
      const clamped = Math.max(0, Math.min(1, result.mssim));
      scores.push(clamped);
      completedDims.push({ width: currentWidth, height: currentHeight });

      // Downsample both inputs by 2x for the next scale, unless this was the last one.
      if (scale < usableScales - 1) {
        const [downOrig, downComp] = await Promise.all([
          downsampleRgba(currentOriginal, currentWidth, currentHeight, 2),
          downsampleRgba(currentCompressed, currentWidth, currentHeight, 2),
        ]);
        currentOriginal = downOrig.data;
        currentCompressed = downComp.data;
        currentWidth = downOrig.width;
        currentHeight = downOrig.height;
      }
    }

    // Renormalize the weights over only the scales we actually ran. Without
    // this, a partial-scale fallback (small image or extreme aspect ratio)
    // would produce a score on a different scale than the full 5-scale case
    // and the optimizer's threshold check (>= 0.985) would behave unfairly.
    if (scores.length === 0) {
      // Couldn't run any scale (extreme degenerate input). Treat as "didn't work".
      return {
        score: 0,
        metric: PERCEPTUAL_METRIC_NAME,
        dimensions: { width: workWidth, height: workHeight },
      };
    }

    const usableWeights = MS_SSIM_WEIGHTS.slice(0, scores.length);
    const usableWeightSum = usableWeights.reduce((a, b) => a + b, 0);
    const normalizedWeights = usableWeights.map((w) => w / usableWeightSum);

    // Geometric mean: product of (score ^ normalized_weight). Clamp tiny
    // scores to a small epsilon so a single zero-scoring scale doesn't drag
    // the whole product to 0; Wang et al's clipping handles this implicitly
    // because their reference inputs never hit the zero band.
    let finalScore = 1.0;
    for (let i = 0; i < scores.length; i++) {
      const safe = scores[i] < 1e-9 ? 1e-9 : scores[i];
      finalScore *= Math.pow(safe, normalizedWeights[i]);
    }

    // Re-clamp in case of float drift from Math.pow.
    finalScore = Math.max(0, Math.min(1, finalScore));

    return {
      score: finalScore,
      metric: PERCEPTUAL_METRIC_NAME,
      dimensions: { width: workWidth, height: workHeight },
    };
  } catch (error) {
    // Fail soft so the optimizer's binary search interprets the failure as
    // "this quality didn't work" and tries another. Returning 0 (rather than
    // throwing) matches calculateSSIM's behavior pattern: both scorers swallow
    // and return a low fallback so a bad encode at one quality doesn't abort
    // the whole optimization. SSIM returns 0.95 (near-acceptance for some
    // legacy thresholds, rejection for the perceptual 0.985 threshold);
    // perceptual returns 0 (clear rejection in every mode).
    console.error("calculatePerceptualScore error:", error);
    return {
      score: 0,
      metric: PERCEPTUAL_METRIC_NAME,
      dimensions: { width: 0, height: 0 },
    };
  }
}
