import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings, type ComposerSendKey, type SendBehavior } from "@/hooks/use-settings";
import { getShortcutOs } from "@/utils/shortcut-platform";

const SEND_BEHAVIORS: readonly SendBehavior[] = ["interrupt", "steer", "queue"];
const COMPOSER_SEND_KEYS: readonly ComposerSendKey[] = ["enter", "shift-enter", "meta-enter"];

const SEND_KEY_LABEL_KEYS: Record<ComposerSendKey, string> = {
  enter: "settings.general.sendKey.options.enter",
  "shift-enter": "settings.general.sendKey.options.shiftEnter",
  "meta-enter": "settings.general.sendKey.options.metaEnter",
};

const SEND_KEY_DESCRIPTION_KEYS: Record<ComposerSendKey, string> = {
  enter: "settings.general.sendKey.descriptions.enter",
  "shift-enter": "settings.general.sendKey.descriptions.shiftEnter",
  "meta-enter": "settings.general.sendKey.descriptions.metaEnter",
};

export function SendingSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const showSendKey = !useIsCompactFormFactor();
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
  // The chord is named after the key people actually press, so the Mod option changes with the OS.
  const modLabel = getShortcutOs() === "mac" ? "Cmd" : "Ctrl";
  const sendKeyOptions = useMemo(
    () =>
      COMPOSER_SEND_KEYS.map((value) => ({
        value,
        label: t(SEND_KEY_LABEL_KEYS[value], { mod: modLabel }),
      })),
    [modLabel, t],
  );
  const changeSendKey = useCallback(
    (composerSendKey: ComposerSendKey) => void updateSettings({ composerSendKey }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.general.defaultSend.label")}
          hint={t(`settings.general.defaultSend.descriptions.${settings.sendBehavior}`)}
          value={settings.sendBehavior}
          options={options}
          onValueChange={change}
        />
        {showSendKey ? (
          <SettingsSelect
            label={t("settings.general.sendKey.label")}
            hint={t(SEND_KEY_DESCRIPTION_KEYS[settings.composerSendKey], { mod: modLabel })}
            value={settings.composerSendKey}
            options={sendKeyOptions}
            onValueChange={changeSendKey}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
