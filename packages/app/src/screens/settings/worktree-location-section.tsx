import { useCallback, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react-native";
import type { WorktreeLocation } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useToast } from "@/contexts/toast-context";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const MODES = ["managed", "sibling", "nested", "custom"] as const;
type Mode = (typeof MODES)[number];

function dropdownTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

function modeOf(location: WorktreeLocation | null | undefined): Mode {
  return location?.mode ?? "managed";
}

function labelFor(t: TFunction, mode: Mode): string {
  return t(`settings.project.worktreeLocation.modes.${mode}`);
}

/**
 * Previews the holder against this project's root so the modes are legible
 * without opening docs. Mirrors resolveWorktreeHolderDir; managed is shown as
 * its shape rather than a real path because the hash is derived on the daemon.
 */
function previewHolder(mode: Mode, repoRoot: string, customRoot: string): string {
  const normalized = repoRoot.replace(/[/\\]+$/, "");
  const separator = normalized.includes("\\") ? "\\" : "/";
  const segments = normalized.split(/[/\\]/);
  const base = segments[segments.length - 1] ?? normalized;
  const parent = segments.slice(0, -1).join(separator);

  switch (mode) {
    case "managed":
      return `<paseo>${separator}worktrees${separator}<hash>${separator}<name>`;
    case "sibling":
      return `${parent}${separator}${base}-worktrees${separator}<name>`;
    case "nested":
      return `${normalized}${separator}.worktrees${separator}<name>`;
    case "custom":
      return customRoot.trim().length > 0
        ? `${customRoot.replace(/[/\\]+$/, "")}${separator}<name>`
        : "";
  }
}

interface ModeMenuItemProps {
  mode: Mode;
  selected: boolean;
  onChange: (mode: Mode) => void;
}

function ModeMenuItem({ mode, selected, onChange }: ModeMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(mode), [onChange, mode]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {labelFor(t, mode)}
    </DropdownMenuItem>
  );
}

export interface WorktreeLocationSectionProps {
  client: Pick<DaemonClient, "setProjectWorktreeLocation">;
  projectId: string;
  repoRoot: string;
  location: WorktreeLocation | null;
}

/**
 * Machine-local, so it writes straight through its own RPC rather than joining
 * the paseo.json draft the rest of this screen saves. The group deliberately has
 * no Save button: two save models under one button is the trap here, and the
 * resolved-path preview is what stops an immediate write reading as unsaved.
 */
export function WorktreeLocationSection({
  client,
  projectId,
  repoRoot,
  location,
}: WorktreeLocationSectionProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [customRoot, setCustomRoot] = useState(location?.mode === "custom" ? location.root : "");
  const [error, setError] = useState<string | null>(null);

  const mode = modeOf(location);

  const mutation = useMutation({
    mutationFn: (next: WorktreeLocation | null) =>
      client.setProjectWorktreeLocation(projectId, next),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (mutationError: unknown) => {
      const message =
        mutationError instanceof Error
          ? mutationError.message
          : t("settings.project.worktreeLocation.saveFailed");
      setError(message);
      toast.show(t("settings.project.worktreeLocation.saveFailed"), { variant: "error" });
    },
  });

  const handleModeChange = useCallback(
    (next: Mode) => {
      if (next === "custom") {
        // Nothing to persist until there is a path; the input is revealed first.
        setError(null);
        if (customRoot.trim().length === 0) return;
        mutation.mutate({ mode: "custom", root: customRoot.trim() });
        return;
      }
      setError(null);
      mutation.mutate(next === "managed" ? null : { mode: next });
    },
    [customRoot, mutation],
  );

  const handleCustomCommit = useCallback(() => {
    const trimmed = customRoot.trim();
    if (trimmed.length === 0) return;
    setError(null);
    mutation.mutate({ mode: "custom", root: trimmed });
  }, [customRoot, mutation]);

  const preview = useMemo(
    () => previewHolder(mode, repoRoot, customRoot),
    [mode, repoRoot, customRoot],
  );

  const showCustom = mode === "custom";

  return (
    <SettingsGroup
      title={t("settings.project.worktreeLocation.title")}
      info={t("settings.project.worktreeLocation.info")}
      testID="worktree-location-group"
    >
      <View style={settingsStyles.card}>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.project.worktreeLocation.label")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.project.worktreeLocation.description")}
            </Text>
            {preview.length > 0 ? (
              <Text style={styles.preview} testID="worktree-location-preview">
                {preview}
              </Text>
            ) : null}
          </View>
          <DropdownMenu>
            <DropdownMenuTrigger
              style={dropdownTriggerStyle}
              testID="worktree-location-trigger"
              accessibilityLabel={t("settings.project.worktreeLocation.accessibilityLabel", {
                value: labelFor(t, mode),
              })}
            >
              <Text style={styles.triggerText}>{labelFor(t, mode)}</Text>
              <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" width={240}>
              {MODES.map((option) => (
                <ModeMenuItem
                  key={option}
                  mode={option}
                  selected={option === mode}
                  onChange={handleModeChange}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        {showCustom ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.project.worktreeLocation.customPathLabel")}
              </Text>
              <TextInput
                testID="worktree-location-custom-input"
                accessibilityLabel={t("settings.project.worktreeLocation.customPathAccessibility")}
                initialValue={customRoot}
                onChangeText={setCustomRoot}
                onBlur={handleCustomCommit}
                onSubmitEditing={handleCustomCommit}
                placeholder={t("settings.project.worktreeLocation.customPathPlaceholder")}
              />
            </View>
          </View>
        ) : null}

        {error ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowError} testID="worktree-location-error">
              {error}
            </Text>
          </View>
        ) : null}

        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowHint}>
              {t("settings.project.worktreeLocation.noMigrationNote")}
            </Text>
            {mode !== "managed" ? (
              <Text style={settingsStyles.rowHint}>
                {t("settings.project.worktreeLocation.externalRemovalNote")}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </SettingsGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: {
    opacity: 0.85,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
}));
