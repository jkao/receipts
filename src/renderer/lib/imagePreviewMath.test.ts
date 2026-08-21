import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_ZOOM,
  MIN_IMAGE_ZOOM,
  clampImageZoom,
  constrainImagePan,
  containSize,
  midpoint,
  panForPinch,
  panForZoomAnchor,
  pointDistance,
  zoomForWheel,
} from "./imagePreviewMath";

describe("image preview geometry", () => {
  it("clamps invalid and infinite zoom values safely", () => {
    expect(clampImageZoom(Number.NaN)).toBe(MIN_IMAGE_ZOOM);
    expect(clampImageZoom(Number.NEGATIVE_INFINITY)).toBe(MIN_IMAGE_ZOOM);
    expect(clampImageZoom(Number.POSITIVE_INFINITY)).toBe(MAX_IMAGE_ZOOM);
  });

  it("fits a tall receipt inside its viewport", () => {
    expect(containSize({ width: 360, height: 420 }, { width: 1200, height: 2400 })).toEqual({
      width: 210,
      height: 420,
    });
  });

  it("keeps the cursor anchor stationary while zooming", () => {
    const pan = panForZoomAnchor({ x: 10, y: -5 }, 1, 2, { x: 60, y: 40 });
    expect(pan).toEqual({ x: -40, y: -50 });
  });

  it("calculates a two-pointer midpoint and distance", () => {
    expect(midpoint({ x: 10, y: 20 }, { x: 50, y: 80 })).toEqual({ x: 30, y: 50 });
    expect(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("anchors pinch zoom while following midpoint translation", () => {
    expect(panForPinch({ x: 10, y: -5 }, 1, 2, { x: 60, y: 40 }, { x: 80, y: 25 })).toEqual({
      x: -20,
      y: -65,
    });
    expect(panForPinch({ x: 10, y: -5 }, 2, 2, { x: 60, y: 40 }, { x: 80, y: 25 })).toEqual({
      x: 30,
      y: -20,
    });
  });

  it("constrains panning without adding movement on a letterboxed axis", () => {
    expect(
      constrainImagePan(
        { x: 500, y: -500 },
        2,
        { width: 360, height: 420 },
        { width: 210, height: 420 }
      )
    ).toEqual({ x: 30, y: -210 });
    expect(
      constrainImagePan(
        { x: 40, y: 40 },
        1,
        { width: 360, height: 420 },
        { width: 210, height: 420 }
      )
    ).toEqual({ x: 0, y: 0 });
  });

  it("zooms in and out with modifier wheel gestures and honors limits", () => {
    expect(zoomForWheel(1, -10, 0, true, 420)).toBeGreaterThan(1);
    expect(zoomForWheel(2, 10, 0, true, 420)).toBeLessThan(2);
    expect(zoomForWheel(MIN_IMAGE_ZOOM, 10_000, 0, true, 420)).toBe(MIN_IMAGE_ZOOM);
    expect(zoomForWheel(MAX_IMAGE_ZOOM, -10_000, 0, true, 420)).toBe(MAX_IMAGE_ZOOM);
  });
});
