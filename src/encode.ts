import sharp from "sharp";
import type { ImageFormat } from "./types";

/**
 * Encode image with specified format and quality
 */
export async function encodeImage(
  inputBuffer: Buffer,
  format: ImageFormat,
  quality: number,
): Promise<Buffer> {
  const image = sharp(inputBuffer);

  switch (format) {
    case "webp":
      return await image
        .webp({
          quality,
          effort: 3, // Faster encoding for production (0=fastest, 6=slowest)
        })
        .toBuffer();

    case "avif":
      return await image
        .avif({
          quality,
          effort: 2, // Faster encoding for production (0=fastest, 9=slowest)
          chromaSubsampling: "4:2:0", // Faster encoding with minimal quality loss
        })
        .toBuffer();

    case "jpeg":
      return await image
        .jpeg({
          quality,
          mozjpeg: true, // Use mozjpeg for better compression
        })
        .toBuffer();

    case "png":
      // PNG can be lossy or lossless depending on quality setting
      // Quality 80-100: Lossless with varying compression levels
      // Quality 1-79: Lossy compression using color reduction
      if (quality >= 80) {
        // Lossless mode - use compression level
        return await image
          .png({
            compressionLevel: 9, // Maximum compression for lossless
            progressive: true,
            adaptiveFiltering: true,
          })
          .toBuffer();
      } else {
        // Lossy mode - reduce colors for smaller file size
        // Map quality 1-79 to colors 16-256
        // Lower quality = fewer colors = smaller file
        const colors = Math.max(16, Math.min(256, Math.floor((quality / 79) * 240) + 16));

        return await image
          .png({
            compressionLevel: 9,
            progressive: true,
            palette: true, // Enable palette-based compression
            colors, // Limit color palette for lossy compression
            quality, // Additional quality parameter
            dither: 1.0, // Use dithering to improve appearance with reduced colors
          })
          .toBuffer();
      }

    case "gif":
      // GIF has limited optimization, use dithering control
      return await image
        .gif({
          effort: Math.min(10, Math.max(1, Math.floor(quality / 10))),
        })
        .toBuffer();

    case "tiff":
      return await image
        .tiff({
          quality,
          compression: "jpeg",
        })
        .toBuffer();

    case "heif":
      return await image
        .heif({
          quality,
        })
        .toBuffer();

    default: {
      throw new Error(`Unsupported format: ${format as string}`);
    }
  }
}
