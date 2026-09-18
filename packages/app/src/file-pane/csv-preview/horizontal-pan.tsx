import type { ReactNode } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSharedValue, type SharedValue } from "react-native-reanimated";

const csvNativeHorizontalPanStyle = { flex: 1, minHeight: 0 } as const;

export function CsvHorizontalPan({
  children,
  scrollX,
  maxScrollX,
}: {
  children: ReactNode;
  scrollX: SharedValue<number>;
  maxScrollX: SharedValue<number>;
}) {
  const startOffset = useSharedValue(0);
  const gesture = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-12, 12])
    .onBegin(() => {
      startOffset.value = scrollX.value;
    })
    .onUpdate((event) => {
      scrollX.value = Math.min(
        maxScrollX.value,
        Math.max(0, startOffset.value - event.translationX),
      );
    });

  return (
    <GestureDetector gesture={gesture}>
      <View style={csvNativeHorizontalPanStyle}>{children}</View>
    </GestureDetector>
  );
}
