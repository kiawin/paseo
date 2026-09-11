import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings, type SendShortcut, type SendBehavior } from "@/hooks/use-settings";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { getShortcutOs } from "@/utils/shortcut-platform";

const SEND_BEHAVIORS: readonly SendBehavior[] = ["interrupt", "steer", "queue"];
const SEND_SHORTCUTS: readonly SendShortcut[] = ["enter", "shift-enter", "mod-enter"];

const SEND_KEY_LABEL_KEYS: Record<SendShortcut, string> = {
  enter: "settings.general.sendKey.options.enter",
  "shift-enter": "settings.general.sendKey.options.shiftEnter",
  "mod-enter": "settings.general.sendKey.options.metaEnter",
};

const SEND_KEY_DESCRIPTION_KEYS: Record<SendShortcut, string> = {
  enter: "settings.general.sendKey.descriptions.enter",
  "shift-enter": "settings.general.sendKey.descriptions.shiftEnter",
  "mod-enter": "settings.general.sendKey.descriptions.metaEnter",
};

export function SendingSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  const isCompact = useIsCompactFormFactor();
  const modifier = getShortcutOs() === "mac" ? "⌘" : "Ctrl";
  const showSendKey = shortcutsAvailable && !isCompact;
  const modLabel = getShortcutOs() === "mac" ? "Cmd" : "Ctrl";
  const options = useMemo(
    () =>
      SEND_BEHAVIORS.map((value) => ({
        value,
        label: t(`settings.general.defaultSend.options.${value}`),
      })),
    [t],
  );
  const change = useCallback(
    (sendBehavior: SendBehavior) => void updateSettings({ sendBehavior }),
    [updateSettings],
  );
  const sendKeyOptions = useMemo(
    () =>
      SEND_SHORTCUTS.map((value) => ({
        value,
        label: t(SEND_KEY_LABEL_KEYS[value], { mod: modLabel }),
      })),
    [modLabel, t],
  );
  const changeSendShortcut = useCallback(
    (sendShortcut: SendShortcut) => void updateSettings({ sendShortcut }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        {showSendKey ? (
          <SettingsSelect
            label={t("settings.general.sendKey.label")}
            hint={t(SEND_KEY_DESCRIPTION_KEYS[settings.sendShortcut], { mod: modLabel })}
            value={settings.sendShortcut}
            options={sendKeyOptions}
            onValueChange={changeSendShortcut}
          />
        ) : null}
        <SettingsSelect
          label={t("settings.general.defaultSend.label")}
          hint={t(
            showSendKey && settings.sendShortcut === "mod-enter"
              ? `settings.general.defaultSend.commandEnterDescriptions.${settings.sendBehavior}`
              : `settings.general.defaultSend.descriptions.${settings.sendBehavior}`,
            { modifier },
          )}
          value={settings.sendBehavior}
          options={options}
          onValueChange={change}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
