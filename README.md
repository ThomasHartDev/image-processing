# @thomashartdev/image-processing

[![CI](https://github.com/thomashartdev/image-processing/actions/workflows/ci.yml/badge.svg)](https://github.com/thomashartdev/image-processing/actions/workflows/ci.yml)

Sharp-based image optimizer with SSIM-driven quality search and perceptual scoring. The canonical image-processing library across Thomas's projects (pixel-wand, atlas, future consumers).

## Install

```bash
pnpm add github:ThomasHartDev/image-processing#v0.3.0
```

The `prepare` lifecycle script runs `pnpm build` automatically on install, so consumers get a built `dist/` without thinking about it.

If consuming from a Next.js app, mark the package server-external so Sharp's native bindings load at runtime instead of being bundled:

```ts
// next.config.ts
const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp", "@thomashartdev/image-processing"],
};
```

## What's exported

```ts
import {
  optimizeImage,
  findOptimalQuality,
  calculatePerceptualScore,
  getFormatRecommendation,
  encodeImage,
  InputTooLargeError,
  InputTooLargeDimensionsError,
  type ImageFormat,
  type OptimizationLevel,
  type OptimizationOptions,
  type OptimizationResult,
  SSIM_TARGETS,
  PERCEPTUAL_METRIC_NAME,
} from "@thomashartdev/image-processing";
```

- `optimizeImage(buffer, opts)` — encode + (optional) quality search + (optional) resize. Returns `{ buffer, format, quality, ssim, bytes, width, height }`.
- `findOptimalQuality(buffer, opts)` — binary-search the lowest quality that hits an SSIM target.
- `calculatePerceptualScore(a, b)` — multi-scale SSIM between two buffers. Use to verify a compressed copy is "good enough".
- `encodeImage(buffer, opts)` — raw encode (no quality search). The escape hatch when you want full control.
- `getFormatRecommendation(buffer, useCase)` — JPEG vs WebP vs AVIF for a given input.

## Stack

- TypeScript (strict), compiled to CommonJS
- `sharp` for encode/resize (JPEG, WebP, AVIF) and native decode
- `ssim.js` for structural-similarity scoring, driving the quality search and the multi-scale perceptual score
- Vitest for unit tests and the public-API contract test
- Distributed by git URL, not npm (see below)

## Consumers

| Repo | Path |
|---|---|
| `ThomasHartDev/pixel-wand` | `apps/pixel-wand` (the optimizer SaaS) |
| `ThomasHartDev/pixel-wand` | `packages/pixel-wand-mcp` (MCP server exposing the lib as Claude Code tools) |
| `ThomasHartDev/atlas` | atlas (DAM, asset exports) |

When a new project starts depending on the library, add it to the `CONSUMERS` list in `scripts/bump-consumers.sh` so future version bumps reach it automatically.

## Releasing a new version

1. Land changes on master.
2. Bump version in `package.json`.
3. Tag and push:
   ```bash
   git tag v0.4.0
   git push --tags
   ```
4. Open PRs in every consumer to bump the git pin:
   ```bash
   ./scripts/bump-consumers.sh v0.4.0
   ```
5. Merge the consumer PRs after CI is green.

The bump script assumes local clones at `/root/projects/{atlas,pixel-wand}` and authenticated `gh`. It refuses to run if any working tree is dirty.

## Tests

```bash
pnpm install && pnpm test   # vitest unit tests + public-API contract
pnpm smoke                  # end-to-end: synth a PNG, optimize, assert SSIM > 0.9
pnpm typecheck              # tsc --noEmit
```

## Continuous integration

GitHub Actions runs `typecheck`, `test`, and `smoke` on every push to `main` and every pull request (`.github/workflows/ci.yml`). Releases here are just a git tag, so nothing ran before the tag was already pushed. Now the same three checks a release depends on run before merge, which is where they can still stop a broken change.

The `public-api` test asserts the barrel in `src/index.ts` still exports the full documented surface at the right runtime kinds. Consumers (pixel-wand, atlas) import against a tag, so a dropped or renamed export used to surface only when their install broke. The contract test pulls that into CI instead.

## Why git URL, not npm

npm publish requires 2FA on every release. Git URL is zero-credentials — version bumps are `git tag + push`, no token, no OTP. Same redeploy story for consumers.

If a third unrelated consumer ever shows up (a project not in Thomas's tree), or if billing attribution across products becomes a real need, the move is to flip from "library imported by N consumers" to "HTTP service hosted by pixel-wand with a typed SDK." That's sketched in the pixel-wand repo's `docs/decisions/image-processing-service-boundary.md`. Until then, the library is the right shape.
