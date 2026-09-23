import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";

import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";

const ThemedSearch = withUnistyles(Search, (theme) => ({
  color: theme.colors.mutedForeground,
}));
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.mutedForeground,
}));

/** The search box at the top of an Explorer list (Artifacts, Notes). */
export function PanelSearchField({
  testID,
  label,
  onChangeText,
}: {
  testID: string;
  label: string;
  onChangeText: (text: string) => void;
}) {
  const [isFocused, setIsFocused] = useState(false);
  const onFocus = useCallback(() => setIsFocused(true), []);
  const onBlur = useCallback(() => setIsFocused(false), []);
  return (
    <View style={[styles.field, isFocused && styles.fieldFocused]}>
      <ThemedSearch size={16} />
      <ThemedTextInput
        testID={testID}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        accessibilityLabel={label}
        placeholder={label}
        // @ts-expect-error - outlineStyle is web-only
        style={[styles.input, isWeb && { outlineStyle: "none" }]}
        maxLength={200}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

export function PanelSearchFailure({
  testID,
  message,
  onRetry,
}: {
  testID: string;
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.failure} testID={`${testID}-error`}>
      <Text style={styles.error}>{message}</Text>
      <Button size="xs" variant="ghost" onPress={onRetry} testID={`${testID}-retry`}>
        {t("common.actions.retry")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    margin: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
  },
  fieldFocused: {
    outlineColor: theme.colors.accent,
    outlineOffset: 1,
    outlineStyle: "solid" as const,
    outlineWidth: 2,
  },
  input: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  failure: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[3],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
}));
