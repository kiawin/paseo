// Bridges Reanimated's web-utils imports to RNW's real style helpers so browser tests exercise
// the animated DOM style path. These are RNW-internal paths pinned to the current RNW version.
import createReactDOMStyle from "react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle";
import {
  createTextShadowValue,
  createTransformValue,
} from "react-native-web/dist/exports/StyleSheet/preprocess";

export { createReactDOMStyle, createTextShadowValue, createTransformValue };
