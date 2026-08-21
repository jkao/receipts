export const MIN_IMAGE_ZOOM = 1;
export const MAX_IMAGE_ZOOM = 5;

export interface PreviewPoint {
  x: number;
  y: number;
}

export interface PreviewSize {
  width: number;
  height: number;
}

export function clampImageZoom(value: number): number {
  if (Number.isNaN(value)) return MIN_IMAGE_ZOOM;
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, value));
}

export function containSize(viewport: PreviewSize, natural: PreviewSize): PreviewSize {
  if (viewport.width <= 0 || viewport.height <= 0 || natural.width <= 0 || natural.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(viewport.width / natural.width, viewport.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

export function constrainImagePan(
  pan: PreviewPoint,
  zoom: number,
  viewport: PreviewSize,
  fittedImage: PreviewSize
): PreviewPoint {
  const maxX = Math.max(0, (fittedImage.width * zoom - viewport.width) / 2);
  const maxY = Math.max(0, (fittedImage.height * zoom - viewport.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

/** Keep the image point under the cursor stationary while its scale changes. */
export function panForZoomAnchor(
  pan: PreviewPoint,
  currentZoom: number,
  nextZoom: number,
  anchor: PreviewPoint
): PreviewPoint {
  const ratio = nextZoom / currentZoom;
  return {
    x: anchor.x - ratio * (anchor.x - pan.x),
    y: anchor.y - ratio * (anchor.y - pan.y),
  };
}

export function midpoint(left: PreviewPoint, right: PreviewPoint): PreviewPoint {
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
  };
}

export function pointDistance(left: PreviewPoint, right: PreviewPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

/** Keep the image point beneath a moving two-finger midpoint stationary. */
export function panForPinch(
  startPan: PreviewPoint,
  startZoom: number,
  nextZoom: number,
  startAnchor: PreviewPoint,
  nextAnchor: PreviewPoint
): PreviewPoint {
  const anchoredPan = panForZoomAnchor(startPan, startZoom, nextZoom, startAnchor);
  return {
    x: anchoredPan.x + nextAnchor.x - startAnchor.x,
    y: anchoredPan.y + nextAnchor.y - startAnchor.y,
  };
}

export function zoomForWheel(
  currentZoom: number,
  deltaY: number,
  deltaMode: number,
  modifierGesture: boolean,
  viewportHeight: number
): number {
  const pixels =
    deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(viewportHeight, 1) : 1);
  const sensitivity = modifierGesture ? 0.01 : 0.0025;
  return clampImageZoom(currentZoom * Math.exp(-pixels * sensitivity));
}
