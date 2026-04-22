# @thomas/image-processing

Shared image optimization core built on `sharp` + `ssim.js`. Consumed by the
pixel-wand app and (eventually) the Atlas DAM app.

## Public API

```ts
import {
  optimizeImage,
  encodeImage,
  findOptimalQuality,
  findOptimalSizeKB,
  calculateSSIM,
  getFormatRecommendation,
  FORMAT_QUALITY_RANGES,
  MIN_QUALITY_FLOOR,
  SSIM_TARGETS,
  type ImageFormat,
  type OptimizationLevel,
  type OptimizationOptions,
  type OptimizationResult,
} from "@thomas/image-processing";
```

### `optimizeImage(buffer, options)`

Top-level entry point. Picks a quality via SSIM-guided binary search (or hits a
target file size if `level: "custom"` + `customTargetSizeKB` is passed) and
returns the encoded buffer plus metadata.

### `encodeImage(buffer, format, quality)`

Low-level encoder wrapper around sharp. Supports `webp`, `avif`, `jpeg`, `png`,
`gif`, `tiff`, `heif`.

### `findOptimalQuality` / `findOptimalSizeKB`

Building blocks used by `optimizeImage`. Exported for callers that want to run
the search without the outer wrapper.

### `calculateSSIM`

Compare two buffers and get the mean SSIM score. Used for quality gates in
tests + smoke scripts.

## Supported formats & quality ranges

See `FORMAT_QUALITY_RANGES` for the actual numbers. Each format has its own
min/max/default; sane floors in `MIN_QUALITY_FLOOR` stop the optimizer from
collapsing to useless quality on modern codecs (webp/avif can hit 0.99 SSIM
even at quality=1).

## Layout

- `types.ts` — type definitions + the lookup tables (`FORMAT_QUALITY_RANGES`,
  `SSIM_TARGETS`, `MIN_QUALITY_FLOOR`).
- `encode.ts` — `encodeImage` (sharp dispatch per format).
- `ssim.ts` — `calculateSSIM` (raw-pixel diff via ssim.js).
- `optimizer.ts` — `optimizeImage`, `findOptimalQuality`, `findOptimalSizeKB`,
  `getFormatRecommendation`.
- `index.ts` — barrel export (this is what consumers import from).
