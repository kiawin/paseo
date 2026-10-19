import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { ScrollText, X } from "lucide-react-native";
import type { ProfileInstructions } from "@/agent-profiles";
import { composerPillStyles } from "@/composer/pill-styles";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";

const ThemedInstructionsIcon = withUnistyles(ScrollText);
const ThemedRemoveIcon = withUnistyles(X);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ComposerProfileInstructionsPillProps {
  instructions: ProfileInstructions;
  onRemove: () => void;
}

/**
 * Shows that the draft will start its agent with a profile's instructions. The
 * instructions are otherwise invisible, and they outlive later model or mode
 * changes, so the draft says so and lets the user drop them.
 */
export function ComposerProfileInstructionsPill({
  instructions,
  onRemove,
}: ComposerProfileInstructionsPillProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );
  const labelStyle = useMemo(
    () => [composerPillStyles.label, isHovered && composerPillStyles.labelActive],
    [isHovered],
  );
  const name = instructions.profileName;
  return (
    <PressHighlight
      testID="composer-profile-instructions-pill"
      accessibilityRole="button"
      accessibilityLabel={t("modelSelector.removeProfileInstructions", { name })}
      onPress={onRemove}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
    >
      <ThemedInstructionsIcon size={14} uniProps={iconColorMapping} />
      <Text style={labelStyle} numberOfLines={1}>
        {t("modelSelector.profileInstructions", { name })}
      </Text>
      <ThemedRemoveIcon size={14} uniProps={iconColorMapping} />
    </PressHighlight>
  );
}
