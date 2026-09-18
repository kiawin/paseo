// Declares the RNW-internal style-helper paths used by the Reanimated browser-test bridge.
// Reanimated needs these declarations for the real style path; keep them pinned to the current RNW version.
declare module "react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle" {
  const createReactDOMStyle: (style: unknown) => Record<string, unknown>;
  export default createReactDOMStyle;
}

declare module "react-native-web/dist/exports/StyleSheet/preprocess" {
  export function createTextShadowValue(style: unknown): string | undefined;
  export function createTransformValue(transform: unknown): string;
}
