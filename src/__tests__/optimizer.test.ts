import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  calculatePerceptualScore,
  encodeImage,
  FORMAT_QUALITY_RANGES,
  findOptimalQuality,
  InputTooLargeDimensionsError,
  InputTooLargeError,
  optimizeImage,
  PERCEPTUAL_METRIC_NAME,
  SSIM_TARGETS,
} from "../index";
import type { ImageFormat } from "../types";

// Build a 500x500 RGB gradient PNG fixture in-memory so we don't ship binaries.
async function makeFixturePng(width = 500, height = 500): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      raw[idx] = Math.floor((x / width) * 255);
      raw[idx + 1] = Math.floor((y / height) * 255);
      raw[idx + 2] = 128;
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

function hasJpegMagic(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function hasPngMagic(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

function hasWebpMagic(buf: Buffer): boolean {
  // RIFF....WEBP — "RIFF" at 0..3, "WEBP" at 8..11.
  return (
    buf.length >= 12 &&
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  );
}

describe("encodeImage", () => {
  it("returns a valid buffer with the correct magic bytes for jpeg, webp, and png", async () => {
    const fixture = await makeFixturePng();

    const [jpeg, webp, png] = await Promise.all([
      encodeImage(fixture, "jpeg", 80),
      encodeImage(fixture, "webp", 82),
      encodeImage(fixture, "png", 90),
    ]);

    expect(Buffer.isBuffer(jpeg)).toBe(true);
    expect(jpeg.length).toBeGreaterThan(0);
    expect(hasJpegMagic(jpeg)).toBe(true);

    expect(Buffer.isBuffer(webp)).toBe(true);
    expect(webp.length).toBeGreaterThan(0);
    expect(hasWebpMagic(webp)).toBe(true);

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.length).toBeGreaterThan(0);
    expect(hasPngMagic(png)).toBe(true);
  });
});

describe("optimizeImage", () => {
  it("round-trip on a 500x500 PNG preserves dimensions when no resize requested", async () => {
    const fixture = await makeFixturePng(500, 500);

    const result = await optimizeImage(fixture, {
      format: "webp",
      level: "maximum-compression",
    });

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(500);
    expect(meta.height).toBe(500);
  });

  it("produces a 200-wide output when maxWidth=200 is passed (aspect preserved)", async () => {
    const fixture = await makeFixturePng(500, 500);

    const result = await optimizeImage(fixture, {
      format: "webp",
      level: "maximum-compression",
      maxWidth: 200,
    });

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height ?? 0).toBeLessThanOrEqual(200);
    expect(meta.height ?? 0).toBeGreaterThan(0);
  });

  it("(a) maxWidth clamps output width", async () => {
    // 800x400 source, maxWidth=400. Width must be clamped to 400.
    const fixture = await makeFixturePng(800, 400);

    const result = await optimizeImage(fixture, {
      format: "webp",
      level: "maximum-compression",
      maxWidth: 400,
    });

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(400);
  });

  it("(b) maxWidth + preserveAspect=true scales proportionally", async () => {
    // 800x400 (2:1 aspect) source. Clamping width to 400 with aspect preserved should give 400x200.
    const fixture = await makeFixturePng(800, 400);

    const result = await optimizeImage(fixture, {
      format: "webp",
      level: "maximum-compression",
      maxWidth: 400,
      preserveAspect: true,
    });

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(200);
  });

  it("(c) maxWidth + preserveAspect=false clamps each dimension independently", async () => {
    // 800x400 source with maxWidth=400 and maxHeight=400 and preserveAspect=false.
    // Should produce exactly 400x400 (fill), ignoring the source aspect ratio.
    const fixture = await makeFixturePng(800, 400);

    const result = await optimizeImage(fixture, {
      format: "webp",
      level: "maximum-compression",
      maxWidth: 400,
      maxHeight: 400,
      preserveAspect: false,
    });

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);
  });

  it("(d) output never upsizes beyond source", async () => {
    // 100x100 source with maxWidth=500 should stay 100x100 — withoutEnlargement guards this.
    const fixture = await makeFixturePng(100, 100);

    const result = await optimizeImage(fixture, {
      format: "webp",
      level: "maximum-compression",
      maxWidth: 500,
    });

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
  });
});

describe("findOptimalQuality", () => {
  it("converges to a quality within the valid webp range", async () => {
    const fixture = await makeFixturePng(300, 300);
    const range = FORMAT_QUALITY_RANGES.webp;

    const result = await findOptimalQuality(fixture, "webp", 0.99, "auto");

    expect(result.quality).toBeGreaterThanOrEqual(10);
    expect(result.quality).toBeLessThanOrEqual(range.max);
    expect(result.ssim).toBeGreaterThan(0);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);
  });
});

describe("FORMAT_QUALITY_RANGES", () => {
  it("covers every supported image format", () => {
    const expected: ImageFormat[] = ["webp", "avif", "jpeg", "png", "gif", "tiff", "heif"];
    for (const fmt of expected) {
      const range = FORMAT_QUALITY_RANGES[fmt];
      expect(range).toBeDefined();
      expect(typeof range.min).toBe("number");
      expect(typeof range.max).toBe("number");
      expect(typeof range.default).toBe("number");
      expect(range.min).toBeLessThanOrEqual(range.default);
      expect(range.default).toBeLessThanOrEqual(range.max);
    }
  });
});

describe("invalid format handling", () => {
  it("throws when an unsupported format is passed to encodeImage or optimizeImage", async () => {
    const fixture = await makeFixturePng(64, 64);
    const bogus = "bogus" as unknown as ImageFormat;

    await expect(encodeImage(fixture, bogus, 80)).rejects.toThrow();
    await expect(optimizeImage(fixture, { format: bogus, level: "auto" })).rejects.toThrow();
  });
});

describe("input size guard", () => {
  it("rejects input larger than the configured byte cap before any sharp work", async () => {
    // Create a buffer that exceeds a tiny per-call cap. We use a small cap so the test
    // doesn't have to materialize a real 50MB buffer in memory.
    const oversized = Buffer.alloc(1024); // 1KB
    const tinyCap = 512; // 512B cap

    await expect(
      optimizeImage(oversized, {
        format: "webp",
        level: "auto",
        maxInputBytes: tinyCap,
      }),
    ).rejects.toBeInstanceOf(InputTooLargeError);

    // And carries the bytes/maxBytes fields for the route to map to a 413 body.
    try {
      await optimizeImage(oversized, {
        format: "webp",
        level: "auto",
        maxInputBytes: tinyCap,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InputTooLargeError);
      const e = err as InputTooLargeError;
      expect(e.bytes).toBe(1024);
      expect(e.maxBytes).toBe(512);
    }
  });

  it("default 50MB cap is enforced when maxInputBytes is omitted", async () => {
    // Build a buffer > 50MB. Allocating 51MB of zeros is cheap and doesn't decode.
    const oversized = Buffer.alloc(51 * 1024 * 1024);

    await expect(
      optimizeImage(oversized, { format: "webp", level: "auto" }),
    ).rejects.toBeInstanceOf(InputTooLargeError);
  });
});

describe("calculatePerceptualScore (ms-ssim-5scale)", () => {
  it("scores identical buffers at or very near 1.0", async () => {
    const fixture = await makeFixturePng(256, 256);
    const result = await calculatePerceptualScore(fixture, fixture);

    expect(result.metric).toBe(PERCEPTUAL_METRIC_NAME);
    expect(result.metric).toBe("ms-ssim-5scale");
    expect(result.score).toBeGreaterThan(0.999);
    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(result.dimensions.width).toBe(256);
    expect(result.dimensions.height).toBe(256);
  });

  it("scores a heavily compressed copy noticeably lower than identical", async () => {
    const fixture = await makeFixturePng(256, 256);
    // Crush quality to force visible artifacts so the metric has something to penalize.
    const compressed = await encodeImage(fixture, "webp", 5);

    const identical = await calculatePerceptualScore(fixture, fixture);
    const lossy = await calculatePerceptualScore(fixture, compressed);

    // Lossy must score strictly lower than identical. Don't pin an exact value
    // since the synthetic gradient compresses very well — what matters is the
    // metric is monotonic in the right direction.
    expect(lossy.score).toBeLessThan(identical.score);
    expect(lossy.score).toBeGreaterThan(0); // sanity: still in [0,1]
  });

  it("downscales inputs larger than 2000px before scoring (wall-time guard)", async () => {
    const fixture = await makeFixturePng(2400, 1800);
    const result = await calculatePerceptualScore(fixture, fixture);

    expect(result.dimensions.width).toBeLessThanOrEqual(2000);
    expect(result.dimensions.height).toBeLessThanOrEqual(2000);
    // 2400/1800 → max side 2400 → factor 2000/2400 = 0.8333... → 2000x1500
    expect(result.dimensions.width).toBe(2000);
    expect(result.dimensions.height).toBe(1500);
  });

  it("handles tiny inputs (smaller than 5-scale minimum) without throwing", async () => {
    // 32x32 is right at the min — falls back to fewer scales.
    const fixture = await makeFixturePng(32, 32);
    const result = await calculatePerceptualScore(fixture, fixture);

    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1.0);
  });
});

describe("findOptimalQuality with perceptual mode", () => {
  it("uses the perceptual threshold from SSIM_TARGETS and returns a usable buffer", async () => {
    const fixture = await makeFixturePng(300, 300);
    const target = SSIM_TARGETS.perceptual;

    const result = await findOptimalQuality(fixture, "webp", target, "perceptual");

    expect(result.quality).toBeGreaterThanOrEqual(FORMAT_QUALITY_RANGES.webp.min);
    expect(result.quality).toBeLessThanOrEqual(FORMAT_QUALITY_RANGES.webp.max);
    // The "ssim" field carries the perceptual score in this mode (see
    // findOptimalQuality JSDoc). Just assert it's in [0, 1].
    expect(result.ssim).toBeGreaterThanOrEqual(0);
    expect(result.ssim).toBeLessThanOrEqual(1);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("perceptual mode produces a usable optimized buffer through optimizeImage", async () => {
    const fixture = await makeFixturePng(400, 400);

    const result = await optimizeImage(fixture, {
      format: "webp",
      level: "perceptual",
    });

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.format).toBe("webp");

    // Output must be smaller than input (the gradient PNG is fat, webp will crush it).
    expect(result.optimizedSize).toBeLessThan(result.originalSize);
  });

  it("does not break the four legacy modes", async () => {
    // Regression guard: perceptual was added as a new variant. The four
    // existing modes must keep producing bytes that match their old shape.
    const fixture = await makeFixturePng(200, 200);
    const levels = ["auto", "maximum-compression", "maximum-quality", "custom"] as const;

    for (const level of levels) {
      const result = await optimizeImage(fixture, {
        format: "webp",
        level,
        ...(level === "custom" ? { customQuality: 70 } : {}),
      });

      expect(Buffer.isBuffer(result.buffer)).toBe(true);
      expect(result.buffer.length).toBeGreaterThan(0);
      // Existing modes report single-scale SSIM. Has to land in a sane band.
      expect(result.ssim).toBeGreaterThan(0.9);
    }
  });
});

describe("dimension probe guard", () => {
  it("rejects input whose pixel count exceeds the configured cap", async () => {
    // 200x200 fixture, but per-call cap of 100*100 = 10000 pixels. The 40k pixel
    // fixture exceeds the cap, so the dimension guard fires before SSIM search.
    const fixture = await makeFixturePng(200, 200);

    await expect(
      optimizeImage(fixture, {
        format: "webp",
        level: "auto",
        maxPixels: 100 * 100,
      }),
    ).rejects.toBeInstanceOf(InputTooLargeDimensionsError);

    try {
      await optimizeImage(fixture, {
        format: "webp",
        level: "auto",
        maxPixels: 100 * 100,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InputTooLargeDimensionsError);
      const e = err as InputTooLargeDimensionsError;
      expect(e.width).toBe(200);
      expect(e.height).toBe(200);
      expect(e.maxPixels).toBe(10000);
    }
  });

  it("AVIF input gets the tighter pixel cap even when maxPixels would allow it", async () => {
    // Build a 200x200 PNG fixture, encode as AVIF, then feed it back. We set
    // maxPixels=1_000_000 (would allow 200x200=40k) but maxAvifPixels=10_000
    // (rejects 40k). Confirms AVIF takes the tighter path.
    const png = await makeFixturePng(200, 200);
    const avif = await sharp(png).avif({ quality: 50 }).toBuffer();

    // Confirm sharp actually produced an AVIF (heif container).
    const probe = await sharp(avif).metadata();
    expect(probe.format === "heif" || probe.format === "avif").toBe(true);

    await expect(
      optimizeImage(avif, {
        format: "webp",
        level: "auto",
        maxPixels: 1_000_000,
        maxAvifPixels: 10_000,
      }),
    ).rejects.toBeInstanceOf(InputTooLargeDimensionsError);
  });

  it("does NOT throw when input fits under both pixel caps", async () => {
    // 100x100 fixture, defaults are huge. Should pass through.
    const fixture = await makeFixturePng(100, 100);

    const result = await optimizeImage(fixture, {
      format: "webp",
      level: "maximum-compression",
    });

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBeGreaterThan(0);
  });
});

describe("EXIF orientation", () => {
  // A landscape JPEG tagged orientation 6 (rotate 90° CW) displays as
  // portrait. Re-encoding strips EXIF, so the pipeline must bake the
  // rotation into the pixels or every phone/camera photo comes out sideways.
  async function makeRotatedJpeg(): Promise<Buffer> {
    const width = 400;
    const height = 200;
    const raw = Buffer.alloc(width * height * 3, 96);
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
  }

  it("optimizeImage bakes EXIF rotation into the output pixels", async () => {
    const input = await makeRotatedJpeg();
    const result = await optimizeImage(input, {
      format: "webp",
      level: "custom",
      customQuality: 80,
      maxWidth: 2048,
      maxHeight: 2048,
      preserveAspect: true,
    });
    const meta = await sharp(result.buffer).metadata();
    // 400x200 landscape + orientation 6 → displayed 200x400 portrait.
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(400);
    expect(meta.orientation ?? 1).toBe(1);
  });

  it("encodeImage (no resize) also bakes the rotation", async () => {
    const input = await makeRotatedJpeg();
    const out = await encodeImage(input, "webp", 80);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(400);
  });
});
