import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
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
  type PreviewPoint,
  type PreviewSize,
} from "../lib/imagePreviewMath";

interface ImageReceiptPreviewProps {
  alt: string;
  filename: string;
  src: string;
  onError: () => void;
}

interface DragState {
  pointerId: number;
  startClient: PreviewPoint;
  startPan: PreviewPoint;
}

interface PinchState {
  pointerIds: readonly [number, number];
  startAnchor: PreviewPoint;
  startDistance: number;
  startPan: PreviewPoint;
  startZoom: number;
}

const ZERO_POINT: PreviewPoint = { x: 0, y: 0 };
const ZERO_SIZE: PreviewSize = { width: 0, height: 0 };

export function ImageReceiptPreview({ alt, filename, src, onError }: ImageReceiptPreviewProps) {
  const instructionsId = useId();
  const previewRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(MIN_IMAGE_ZOOM);
  const panRef = useRef<PreviewPoint>(ZERO_POINT);
  const dragRef = useRef<DragState | null>(null);
  const pinchRef = useRef<PinchState | null>(null);
  const touchPointsRef = useRef<Map<number, PreviewPoint>>(new Map());
  const [zoom, setZoom] = useState(MIN_IMAGE_ZOOM);
  const [pan, setPan] = useState<PreviewPoint>(ZERO_POINT);
  const [viewport, setViewport] = useState<PreviewSize>(ZERO_SIZE);
  const [naturalSize, setNaturalSize] = useState<PreviewSize>(ZERO_SIZE);
  const [dragging, setDragging] = useState(false);
  const [pinching, setPinching] = useState(false);

  const fittedImage = useMemo(() => containSize(viewport, naturalSize), [naturalSize, viewport]);

  const commitView = useCallback((nextZoom: number, nextPan: PreviewPoint) => {
    if (
      nextZoom === zoomRef.current &&
      nextPan.x === panRef.current.x &&
      nextPan.y === panRef.current.y
    ) {
      return;
    }
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  }, []);

  const constrainPan = useCallback(
    (nextPan: PreviewPoint, nextZoom: number) =>
      constrainImagePan(nextPan, nextZoom, viewport, fittedImage),
    [fittedImage, viewport]
  );

  const resetView = useCallback(() => {
    commitView(MIN_IMAGE_ZOOM, ZERO_POINT);
  }, [commitView]);

  const zoomAt = useCallback(
    (requestedZoom: number, anchor: PreviewPoint = ZERO_POINT) => {
      const currentZoom = zoomRef.current;
      const nextZoom = clampImageZoom(requestedZoom);
      const anchoredPan = panForZoomAnchor(panRef.current, currentZoom, nextZoom, anchor);
      commitView(nextZoom, constrainPan(anchoredPan, nextZoom));
    },
    [commitView, constrainPan]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new image source must reset view and active pointer state even though the effect does not read the URL.
  useEffect(() => {
    const capturedPointerIds = new Set(touchPointsRef.current.keys());
    if (dragRef.current) capturedPointerIds.add(dragRef.current.pointerId);
    touchPointsRef.current.clear();
    dragRef.current = null;
    pinchRef.current = null;
    setDragging(false);
    setPinching(false);
    const viewportElement = viewportRef.current;
    for (const pointerId of capturedPointerIds) {
      if (viewportElement?.hasPointerCapture(pointerId)) {
        viewportElement.releasePointerCapture(pointerId);
      }
    }
    setNaturalSize(ZERO_SIZE);
    resetView();
  }, [resetView, src]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const nextPan = constrainPan(panRef.current, zoomRef.current);
    commitView(zoomRef.current, nextPan);
  }, [commitView, constrainPan]);

  const anchorForClientPoint = useCallback((clientX: number, clientY: number): PreviewPoint => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return ZERO_POINT;
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
  }, []);

  const beginPinch = useCallback((): boolean => {
    const points = [...touchPointsRef.current.entries()].slice(0, 2);
    if (points.length < 2) return false;
    const [[firstId, firstPoint], [secondId, secondPoint]] = points;
    const startDistance = pointDistance(firstPoint, secondPoint);
    if (startDistance <= 0) return false;
    const startMidpoint = midpoint(firstPoint, secondPoint);
    pinchRef.current = {
      pointerIds: [firstId, secondId],
      startAnchor: anchorForClientPoint(startMidpoint.x, startMidpoint.y),
      startDistance,
      startPan: panRef.current,
      startZoom: zoomRef.current,
    };
    dragRef.current = null;
    setDragging(false);
    setPinching(true);
    return true;
  }, [anchorForClientPoint]);

  useEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      const modifierGesture = event.ctrlKey || event.metaKey;
      // Normal two-finger and mouse-wheel scrolling belongs to the drawer.
      // Chromium reports a Mac trackpad pinch as a ctrl-modified wheel event.
      if (!modifierGesture) return;
      const nextZoom = zoomForWheel(
        zoomRef.current,
        event.deltaY,
        event.deltaMode,
        modifierGesture,
        viewport.height
      );
      event.preventDefault();
      zoomAt(nextZoom, anchorForClientPoint(event.clientX, event.clientY));
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, [anchorForClientPoint, viewport.height, zoomAt]);

  const finishPointer = (event: PointerEvent<HTMLDivElement>, releaseCapture = true) => {
    touchPointsRef.current.delete(event.pointerId);
    if (releaseCapture && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }

    const pinch = pinchRef.current;
    if (!pinch?.pointerIds.includes(event.pointerId)) return;
    pinchRef.current = null;
    setPinching(false);

    if (beginPinch()) return;
    const remainingTouch = touchPointsRef.current.entries().next().value as
      | [number, PreviewPoint]
      | undefined;
    if (remainingTouch && zoomRef.current > MIN_IMAGE_ZOOM) {
      dragRef.current = {
        pointerId: remainingTouch[0],
        startClient: remainingTouch[1],
        startPan: panRef.current,
      };
      setDragging(true);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(zoomRef.current * 1.25);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomAt(zoomRef.current / 1.25);
      return;
    }
    if (event.key === "0" || event.key === "Home") {
      event.preventDefault();
      resetView();
      return;
    }
    if (!event.key.startsWith("Arrow") || zoomRef.current <= MIN_IMAGE_ZOOM) return;

    const amount = event.shiftKey ? 48 : 24;
    const movement: PreviewPoint = {
      x: event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0,
      y: event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0,
    };
    event.preventDefault();
    commitView(
      zoomRef.current,
      constrainPan(
        { x: panRef.current.x + movement.x, y: panRef.current.y + movement.y },
        zoomRef.current
      )
    );
  };

  const zoomPercent = Math.round(zoom * 100);
  const isZoomed = zoom > MIN_IMAGE_ZOOM;

  return (
    <div ref={previewRef} className="receipt-preview receipt-preview--image">
      <div className="image-preview-controls" aria-label="Image zoom controls" role="toolbar">
        <button
          aria-label="Zoom out"
          disabled={zoom <= MIN_IMAGE_ZOOM}
          type="button"
          onClick={() => zoomAt(zoomRef.current / 1.25)}
        >
          −
        </button>
        <output aria-label={`Zoom ${zoomPercent} percent`}>{zoomPercent}%</output>
        <button
          aria-label="Zoom in"
          disabled={zoom >= MAX_IMAGE_ZOOM}
          type="button"
          onClick={() => zoomAt(zoomRef.current * 1.25)}
        >
          +
        </button>
        <button
          aria-label="Reset image zoom and position"
          className="image-preview-reset"
          disabled={!isZoomed && pan.x === 0 && pan.y === 0}
          type="button"
          onClick={resetView}
        >
          Reset
        </button>
      </div>

      <div
        ref={viewportRef}
        aria-describedby={instructionsId}
        aria-label={`Interactive preview of ${filename}, zoom ${zoomPercent} percent`}
        className={`image-preview-canvas${isZoomed ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}${pinching ? " is-pinching" : ""}`}
        role="application"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: This custom zoom/pan viewport exposes documented keyboard controls and must be focusable.
        tabIndex={0}
        onDoubleClick={(event) => {
          if (isZoomed) {
            resetView();
          } else {
            zoomAt(2, anchorForClientPoint(event.clientX, event.clientY));
          }
        }}
        onKeyDown={handleKeyDown}
        onLostPointerCapture={(event) => finishPointer(event, false)}
        onPointerCancel={finishPointer}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") {
            touchPointsRef.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            if (pinchRef.current || touchPointsRef.current.size >= 2) {
              event.preventDefault();
              if (!pinchRef.current) beginPinch();
              return;
            }
            if (zoomRef.current <= MIN_IMAGE_ZOOM) return;
            event.preventDefault();
            dragRef.current = {
              pointerId: event.pointerId,
              startClient: { x: event.clientX, y: event.clientY },
              startPan: panRef.current,
            };
            setDragging(true);
            return;
          }

          if (zoomRef.current <= MIN_IMAGE_ZOOM || event.button !== 0) return;
          event.preventDefault();
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          dragRef.current = {
            pointerId: event.pointerId,
            startClient: { x: event.clientX, y: event.clientY },
            startPan: panRef.current,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (event.pointerType === "touch" && touchPointsRef.current.has(event.pointerId)) {
            touchPointsRef.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
          }
          const pinch = pinchRef.current;
          if (pinch?.pointerIds.includes(event.pointerId)) {
            const firstPoint = touchPointsRef.current.get(pinch.pointerIds[0]);
            const secondPoint = touchPointsRef.current.get(pinch.pointerIds[1]);
            if (!firstPoint || !secondPoint) return;
            event.preventDefault();
            const nextDistance = pointDistance(firstPoint, secondPoint);
            const nextZoom = clampImageZoom(pinch.startZoom * (nextDistance / pinch.startDistance));
            const nextMidpoint = midpoint(firstPoint, secondPoint);
            const nextAnchor = anchorForClientPoint(nextMidpoint.x, nextMidpoint.y);
            const nextPan = panForPinch(
              pinch.startPan,
              pinch.startZoom,
              nextZoom,
              pinch.startAnchor,
              nextAnchor
            );
            commitView(nextZoom, constrainPan(nextPan, nextZoom));
            return;
          }

          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.preventDefault();
          const nextPan = constrainPan(
            {
              x: drag.startPan.x + event.clientX - drag.startClient.x,
              y: drag.startPan.y + event.clientY - drag.startClient.y,
            },
            zoomRef.current
          );
          commitView(zoomRef.current, nextPan);
        }}
        onPointerUp={finishPointer}
      >
        <img
          alt={alt}
          draggable={false}
          src={src}
          style={{
            width: `${fittedImage.width}px`,
            height: `${fittedImage.height}px`,
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
          }}
          onError={onError}
          onLoad={(event) => {
            setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            });
          }}
        />
      </div>

      <p className="image-preview-instructions" id={instructionsId}>
        Two-finger pinch or Command/Control-scroll zooms; drag or arrow keys pan. Use +/− to zoom
        and 0 to reset. Double-click to {isZoomed ? "reset" : "zoom in"}.
      </p>
    </div>
  );
}
