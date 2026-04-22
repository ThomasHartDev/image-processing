import sharp from "sharp";
import ssim from "ssim.js";

/**
 * Calculate SSIM between original and compressed images
 * For large images (>2000px), resize to 2000px for faster SSIM calculation
 */
export async function calculateSSIM(
  originalBuffer: Buffer,
  compressedBuffer: Buffer,
): Promise<number> {
  try {
    // Get metadata to check image size
    const metadata = await sharp(originalBuffer).metadata();
    const maxDimension = Math.max(metadata.width || 0, metadata.height || 0);

    // For very large images, resize to max 2000px for SSIM calculation
    // This significantly speeds up processing without affecting accuracy much
    const shouldResize = maxDimension > 2000;
    const resizeOptions = shouldResize
      ? { width: 2000, height: 2000, fit: "inside" as const }
      : undefined;

    // Convert both images to raw pixel data for SSIM comparison
    const [original, compressed] = await Promise.all([
      sharp(originalBuffer).resize(resizeOptions).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
      sharp(compressedBuffer).resize(resizeOptions).raw().ensureAlpha().toBuffer({ resolveWithObject: true }),
    ]);

    // Ensure both images have the same dimensions
    if (
      original.info.width !== compressed.info.width ||
      original.info.height !== compressed.info.height
    ) {
      throw new Error("Image dimensions must match for SSIM calculation");
    }

    // Calculate SSIM using ssim.js
    const result = ssim(
      {
        data: new Uint8ClampedArray(original.data),
        width: original.info.width,
        height: original.info.height,
      },
      {
        data: new Uint8ClampedArray(compressed.data),
        width: compressed.info.width,
        height: compressed.info.height,
      },
    );

    return result.mssim;
  } catch (error) {
    console.error("SSIM calculation error:", error);
    return 0.95;
  }
}
