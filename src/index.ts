// Public barrel export for @thomas/image-processing.
export { encodeImage } from "./encode";
export { calculateSSIM } from "./ssim";
export {
  findOptimalQuality,
  findOptimalSizeKB,
  getFormatRecommendation,
  optimizeImage,
} from "./optimizer";
export {
  FORMAT_QUALITY_RANGES,
  MIN_QUALITY_FLOOR,
  SSIM_TARGETS,
  type ImageFormat,
  type OptimizationLevel,
  type OptimizationOptions,
  type OptimizationResult,
} from "./types";
