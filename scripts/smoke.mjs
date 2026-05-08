#!/usr/bin/env node
// Smoke test for @thomashartdev/image-processing.
// Generates an in-memory 500x500 PNG, runs optimizeImage to JPEG at default
// (level: "auto") options, then asserts the output is non-empty and SSIM > 0.9.

import sharp from "sharp";
import { optimizeImage } from "../dist/index.js";

async function main() {
  // 500x500 gradient PNG, generated in-memory so we don't ship fixtures.
  const width = 500;
  const height = 500;
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      raw[idx] = Math.floor((x / width) * 255); // R
      raw[idx + 1] = Math.floor((y / height) * 255); // G
      raw[idx + 2] = 128; // B
    }
  }

  const pngBuffer = await sharp(raw, { raw: { width, height, channels } }).png().toBuffer();

  if (pngBuffer.length === 0) {
    throw new Error("Test fixture PNG generation returned zero-length buffer");
  }
  console.log(`[smoke] generated source PNG: ${pngBuffer.length} bytes`);

  const result = await optimizeImage(pngBuffer, {
    format: "jpeg",
    level: "auto",
  });

  console.log(
    `[smoke] optimizeImage returned quality=${result.quality} ssim=${result.ssim.toFixed(4)} bytes=${result.optimizedSize} savings=${result.savings}`,
  );

  if (!Buffer.isBuffer(result.buffer) || result.buffer.length === 0) {
    throw new Error(`output buffer empty or invalid (length=${result.buffer?.length ?? "n/a"})`);
  }

  if (!(result.ssim > 0.9)) {
    throw new Error(`SSIM ${result.ssim} is not > 0.9`);
  }

  console.log("[smoke] PASS");
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
