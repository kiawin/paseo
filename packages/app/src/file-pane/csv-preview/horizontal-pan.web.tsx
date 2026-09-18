import {
  useCallback,
  useRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import type { SharedValue } from "react-native-reanimated";

const HORIZONTAL_DRAG_THRESHOLD = 8;

export function CsvHorizontalPan({
  children,
  scrollX,
  maxScrollX,
}: {
  children: ReactNode;
  scrollX: SharedValue<number>;
  maxScrollX: SharedValue<number>;
}) {
  const pointerStart = useRef<{
    id: number;
    x: number;
    offset: number;
    captured: boolean;
  } | null>(null);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      let delta = event.deltaX;
      if (delta === 0 && event.shiftKey) delta = event.deltaY;
      if (delta === 0) return;
      event.preventDefault();
      scrollX.value = clampOffset(scrollX.value + delta, maxScrollX.value);
    },
    [maxScrollX, scrollX],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      pointerStart.current = {
        id: event.pointerId,
        x: event.clientX,
        offset: scrollX.value,
        captured: false,
      };
    },
    [scrollX],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = pointerStart.current;
      if (!start || start.id !== event.pointerId) return;
      const delta = start.x - event.clientX;
      if (!start.captured) {
        if (Math.abs(delta) <= HORIZONTAL_DRAG_THRESHOLD) return;
        start.captured = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      scrollX.value = clampOffset(start.offset + delta, maxScrollX.value);
    },
    [maxScrollX, scrollX],
  );

  const handlePointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (pointerStart.current?.id !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerStart.current = null;
  }, []);

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      onWheel={handleWheel}
      style={csvWebHorizontalPanStyle}
    >
      {children}
    </div>
  );
}

function clampOffset(offset: number, maxOffset: number): number {
  return Math.min(maxOffset, Math.max(0, offset));
}

const csvWebHorizontalPanStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  touchAction: "pan-y",
  userSelect: "none",
};
