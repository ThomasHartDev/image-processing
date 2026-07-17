import { describe, expect, it } from "vitest";
import * as lib from "../index";

// The barrel is what consumers (pixel-wand, atlas) import against a git tag.
// A dropped or renamed runtime export only surfaces when the tag is already
// out and a consumer's install breaks. These tests pull that failure forward
// into CI on every push/PR, before anyone tags.

const FUNCTIONS = [
  "encodeImage",
  "calculatePerceptualScore",
  "calculateSSIM",
  "findOptimalQuality",
  "findOptimalSizeKB",
  "getFormatRecommendation",
  "optimizeImage",
] as const;

const ERROR_CLASSES = ["InputTooLargeError", "InputTooLargeDimensionsError"] as const;

const NUMERIC_CONSTS = [
  "DEFAULT_MAX_AVIF_PIXELS",
  "DEFAULT_MAX_INPUT_BYTES",
  "DEFAULT_MAX_PIXELS",
] as const;

const OBJECT_CONSTS = [
  "FORMAT_QUALITY_RANGES",
  "SSIM_TARGETS",
  "PERCEPTUAL_SCORE_RANGE",
  "MIN_QUALITY_FLOOR",
] as const;

describe("public API surface", () => {
  it.each(FUNCTIONS)("exports %s as a function", (name) => {
    expect(typeof lib[name]).toBe("function");
  });

  it.each(ERROR_CLASSES)("exports %s as an Error subclass", (name) => {
    const Ctor = lib[name] as unknown as new (...args: never[]) => Error;
    expect(typeof Ctor).toBe("function");
    expect(Ctor.prototype).toBeInstanceOf(Error);
  });

  it.each(NUMERIC_CONSTS)("exports %s as a positive finite number", (name) => {
    const value = lib[name] as unknown;
    expect(typeof value).toBe("number");
    expect(Number.isFinite(value)).toBe(true);
    expect(value as number).toBeGreaterThan(0);
  });

  it.each(OBJECT_CONSTS)("exports %s as a non-empty object", (name) => {
    const value = lib[name] as unknown;
    expect(value).toBeTypeOf("object");
    expect(value).not.toBeNull();
    expect(Object.keys(value as object).length).toBeGreaterThan(0);
  });

  it("exports the perceptual metric name matching what the scorer stamps", () => {
    expect(lib.PERCEPTUAL_METRIC_NAME).toBe("ms-ssim-5scale");
  });

  it("has no accidental undefined runtime exports", () => {
    const undefinedKeys = Object.keys(lib).filter(
      (key) => (lib as Record<string, unknown>)[key] === undefined,
    );
    expect(undefinedKeys).toEqual([]);
  });
});
