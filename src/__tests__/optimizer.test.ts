import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  encodeImage,
  FORMAT_QUALITY_RANGES,
  findOptimalQuality,
  InputTooLargeDimensionsError,
  InputTooLargeError,
  optimizeImage,
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
