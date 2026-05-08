// Public barrel export for @thomashartdev/image-processing.
export { encodeImage } from "./encode";
export {
  InputTooLargeDimensionsError,
  InputTooLargeError,
} from "./errors";
export {
  calculatePerceptualScore,
  PERCEPTUAL_METRIC_NAME,
  PERCEPTUAL_SCORE_RANGE,
  type PerceptualScoreResult,
} from "./perceptual";
export { calculateSSIM } from "./ssim";
export {
  findOptimalQuality,
  findOptimalSizeKB,
  getFormatRecommendation,
  optimizeImage,
} from "./optimizer";
export {
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
