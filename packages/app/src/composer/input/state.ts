import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { MessagePayload } from "@/composer/types";
import type { ComposerSendKey } from "@/hooks/use-settings";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";

export type SendBehavior = ActiveTurnBehavior | "queue";

export interface ComposerEnterModifiers {
  shiftKey: boolean;
  /** Command on macOS, Control elsewhere. Either one counts. */
  modKey: boolean;
}

export type ComposerEnterChord = "send" | "alternate-send";

/**
 * Which modifiers each Enter chord carries, per send key. The chords are exclusive: anything not
 * listed here is left to the textarea, which inserts a line break — so "shift-enter" makes plain
 * Enter a newline, and "meta-enter" makes both Enter and Shift+Enter newlines.
 *
 * The alternate send adds the modifier the send chord leaves free, which lands on Mod+Shift+Enter
 * once the send chord already uses Mod.
 */
const COMPOSER_ENTER_CHORDS: Record<
  ComposerSendKey,
  Record<ComposerEnterChord, ComposerEnterModifiers>
> = {
  enter: {
    send: { shiftKey: false, modKey: false },
    "alternate-send": { shiftKey: false, modKey: true },
  },
  "shift-enter": {
    send: { shiftKey: true, modKey: false },
    "alternate-send": { shiftKey: true, modKey: true },
  },
  "meta-enter": {
    send: { shiftKey: false, modKey: true },
    "alternate-send": { shiftKey: true, modKey: true },
  },
};

export function composerSendChordModifiers(sendKey: ComposerSendKey): ComposerEnterModifiers {
  return COMPOSER_ENTER_CHORDS[sendKey].send;
}

export function resolveComposerEnterChord(
  sendKey: ComposerSendKey,
  modifiers: ComposerEnterModifiers,
): ComposerEnterChord | null {
  const chords = COMPOSER_ENTER_CHORDS[sendKey];
  for (const chord of ["send", "alternate-send"] as const) {
    const expected = chords[chord];
    if (expected.shiftKey === modifiers.shiftKey && expected.modKey === modifiers.modKey) {
      return chord;
    }
  }
  return null;
}

export function resolveActiveSendBehavior(
  sendBehavior: SendBehavior,
  hasPendingPermission: boolean,
): SendBehavior {
  return sendBehavior === "queue" && hasPendingPermission ? "interrupt" : sendBehavior;
}

interface ComposerSurfaceState {
  opacity: 0 | 1;
  pointerEvents: "auto" | "none";
}

export interface ComposerSurfacePresentation {
  input: ComposerSurfaceState;
  overlay: ComposerSurfaceState;
}

const INPUT_PRESENTATION: ComposerSurfacePresentation = {
  input: { opacity: 1, pointerEvents: "auto" },
  overlay: { opacity: 0, pointerEvents: "none" },
};

const OVERLAY_PRESENTATION: ComposerSurfacePresentation = {
  input: { opacity: 0, pointerEvents: "none" },
  overlay: { opacity: 1, pointerEvents: "auto" },
};

export function resolveComposerSurfacePresentation(
  showOverlay: boolean,
): ComposerSurfacePresentation {
  return showOverlay ? OVERLAY_PRESENTATION : INPUT_PRESENTATION;
}

interface StopRealtimeVoiceContext {
  voice: { stopVoice: () => Promise<unknown> } | null | undefined;
  isRealtimeVoiceForCurrentAgent: boolean;
  isAgentRunning: boolean;
  client: { cancelAgent: (agentId: string) => Promise<unknown> } | null;
  voiceAgentId: string | undefined;
}

interface SendActionContext {
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  handleSendMessage: () => void;
  handleQueueMessage: () => void;
}

interface DictationTranscriptContext {
  value: string;
  defaultSendBehavior: SendBehavior;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmit: (payload: MessagePayload) => void;
  replaceText: (text: string) => void;
  attachments: MessagePayload["attachments"];
  cwd: string;
  autoSend: boolean;
}

export function applyDictationTranscript(text: string, ctx: DictationTranscriptContext): void {
  if (!text) return;
  const shouldPad = ctx.value.length > 0 && !/\s$/.test(ctx.value);
  const nextValue = `${ctx.value}${shouldPad ? " " : ""}${text}`;

  if (!ctx.autoSend) {
    ctx.replaceText(nextValue);
    return;
  }

  ctx.replaceText(nextValue);

  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.onQueue({ text: nextValue, attachments: ctx.attachments, cwd: ctx.cwd });
    ctx.replaceText("");
    return;
  }

  ctx.onSubmit({
    text: nextValue,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
  });
}

interface MessageInputKeyboardActions {
  focusInput: () => void;
  isDictationRecording: () => boolean;
  markTranscriptForSend: () => void;
  confirmDictation: () => void | Promise<void>;
  cancelDictation: () => void | Promise<void>;
  startDictation: () => void | Promise<void>;
  toggleRealtimeVoice: () => void;
  isRealtimeVoiceActive: boolean;
  toggleRealtimeVoiceMute: () => void;
}

export function computeCanStartDictation(input: {
  client: DaemonClient | null;
  isReadyForDictation: boolean | undefined;
  disabled: boolean;
  dictationUnavailableMessage: string | null | undefined;
}): boolean {
  const socketConnected = input.client?.isConnected ?? false;
  const readyForDictation = input.isReadyForDictation ?? socketConnected;
  return (
    socketConnected && readyForDictation && !input.disabled && !input.dictationUnavailableMessage
  );
}

export function runDefaultSendAction(ctx: SendActionContext): void {
  if (ctx.defaultSendBehavior === "queue" && ctx.isAgentRunning && ctx.onQueue) {
    ctx.handleQueueMessage();
    return;
  }
  ctx.handleSendMessage();
}

export function runAlternateSendAction(ctx: SendActionContext): void {
  if (ctx.defaultSendBehavior === "queue") {
    ctx.handleSendMessage();
    return;
  }
  if (ctx.isAgentRunning && ctx.onQueue) {
    ctx.handleQueueMessage();
  }
}

export function runMessageInputKeyboardAction(
  action: MessageInputKeyboardActionKind,
  actions: MessageInputKeyboardActions,
): boolean {
  if (action === "focus") {
    actions.focusInput();
    return true;
  }
  if (action === "send" || action === "dictation-confirm") {
    if (actions.isDictationRecording()) {
      actions.markTranscriptForSend();
      void actions.confirmDictation();
      return true;
    }
    return false;
  }
  if (action === "voice-toggle") {
    actions.toggleRealtimeVoice();
    return true;
  }
  if (action === "voice-mute-toggle") {
    if (actions.isRealtimeVoiceActive) {
      actions.toggleRealtimeVoiceMute();
    }
    return true;
  }
  if (action === "dictation-cancel") {
    if (actions.isDictationRecording()) {
      void actions.cancelDictation();
      return true;
    }
    return false;
  }
  if (action === "dictation-toggle") {
    if (actions.isDictationRecording()) {
      actions.markTranscriptForSend();
      void actions.confirmDictation();
    } else {
      void actions.startDictation();
    }
    return true;
  }
  return false;
}

export async function stopRealtimeVoice(ctx: StopRealtimeVoiceContext): Promise<void> {
  if (!ctx.voice || !ctx.isRealtimeVoiceForCurrentAgent) return;

  if (ctx.isAgentRunning) {
    if (!ctx.client || !ctx.voiceAgentId) {
      throw new Error("Cannot stop the running voice agent while the host is unavailable");
    }
    await ctx.client.cancelAgent(ctx.voiceAgentId);
  }

  await ctx.voice.stopVoice();
}
