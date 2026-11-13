import { ipcRenderer } from "electron";
import type { BrowserKeyboardPolicy, BrowserShortcutPrefix } from "./policy.js";

const POLICY_CHANNEL = "paseo:browser-keyboard-policy";
const POLICY_REQUEST_CHANNEL = "paseo:browser-keyboard-policy-request";
const SHORTCUT_INPUT_CHANNEL = "paseo:browser-shortcut-input";
const RECORDING_STATE_CHANNEL = "paseo:browser-recording-state";
const RECORDING_HELLO_CHANNEL = "paseo:browser-recording-document";
const RECORDING_CLICK_CHANNEL = "paseo:browser-recording-click";

// This property exists only in Electron's isolated preload world. The main
// process resolves it through CDP to link the sender frame to its CDP frame.
const recordingNonce = (() => {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    Object.defineProperty(globalThis, "__paseoRecordingNonce", { value: nonce });
    return nonce;
  } catch {
    // Recording must not prevent the existing keyboard preload from starting.
    return null;
  }
})();
let recordingEnabled = false;

interface VisibleTextState {
  value: string;
  pendingSpace: boolean;
  budget: number;
  truncated: boolean;
}
function appendVisibleText(state: VisibleTextState, text: string): void {
  const segment = text.slice(0, state.budget);
  state.budget -= segment.length;
  for (const character of segment) {
    if (/\s/.test(character)) {
      if (state.value) state.pendingSpace = true;
      continue;
    }
    const prefix = state.pendingSpace ? " " : "";
    if (state.value.length + prefix.length + character.length > 256) {
      state.truncated = true;
      break;
    }
    state.value += prefix + character;
    state.pendingSpace = false;
  }
  if (text.length > segment.length) state.truncated = true;
}

function recordingElement(event: MouseEvent): Record<string, unknown> | null {
  const target = event
    .composedPath()
    .find((candidate): candidate is Element => candidate instanceof Element);
  if (!target) return null;
  const element =
    target.closest(
      "button, a[href], [role='button'], [role='link'], summary, label, input, select, textarea",
    ) ?? target;
  const input = element instanceof HTMLInputElement ? element : null;
  const secretInput = input?.type.toLowerCase() === "password";
  let truncated = false;
  const clip = (value: string | null, max: number) => {
    if ((value?.length ?? 0) > max) truncated = true;
    return (value ?? "")
      .slice(0, max * 4)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  };
  const visibleText = () => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role")?.toLowerCase();
    if (
      secretInput ||
      element.closest("[contenteditable], textarea") ||
      !(
        ["button", "a", "label", "summary", "option"].includes(tag) ||
        role === "button" ||
        role === "link"
      )
    )
      return "";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const state: VisibleTextState = {
      value: "",
      pendingSpace: false,
      budget: 8192,
      truncated: false,
    };
    for (let count = 0; count <= 50; count += 1) {
      const node = walker.nextNode();
      if (!node) break;
      if (count === 50) {
        truncated = true;
        break;
      }
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest("script, style, textarea, [hidden], [aria-hidden='true'], [contenteditable]")
      )
        continue;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") continue;
      appendVisibleText(state, node.nodeValue ?? "");
      if (state.truncated) {
        truncated = true;
        break;
      }
      if (state.budget === 0) {
        if (walker.nextNode()) truncated = true;
        break;
      }
    }
    return state.value;
  };
  const label =
    element.getAttribute("aria-label") || element.getAttribute("title") || visibleText();
  const link = element.closest("a[href]");
  const descriptor = {
    tag: clip(element.tagName.toLowerCase(), 64),
    id: clip(element.id, 256),
    name: clip(element.getAttribute("name"), 256),
    role: clip(element.getAttribute("role"), 128),
    label: clip(label, 256),
    href: link instanceof HTMLAnchorElement ? clip(link.href, 2048) : "",
  };
  return { ...descriptor, truncated };
}

let forwardedLabel: { control: HTMLElement; at: number; x: number; y: number } | null = null;
function recordActivation(event: MouseEvent): void {
  if (!recordingEnabled || !recordingNonce || !event.isTrusted) return;
  if (event.type === "auxclick" && event.button !== 1) return;
  const target = event.composedPath().find((item): item is Element => item instanceof Element);
  if (
    target &&
    forwardedLabel &&
    target === forwardedLabel.control &&
    event.timeStamp >= forwardedLabel.at &&
    event.timeStamp - forwardedLabel.at < 100 &&
    event.clientX === forwardedLabel.x &&
    event.clientY === forwardedLabel.y
  ) {
    forwardedLabel = null;
    return;
  }
  const label = target?.closest("label");
  forwardedLabel =
    label instanceof HTMLLabelElement &&
    label.control instanceof HTMLElement &&
    label.control !== target
      ? { control: label.control, at: event.timeStamp, x: event.clientX, y: event.clientY }
      : null;
  const element = recordingElement(event);
  if (!element) return;
  ipcRenderer.send(RECORDING_CLICK_CHANNEL, {
    nonce: recordingNonce,
    at: performance.timeOrigin + event.timeStamp,
    activation: event.detail === 0 ? "keyboard-or-assistive" : "pointer",
    button: event.type === "auxclick" ? "middle" : "primary",
    modifiers: {
      alt: event.altKey,
      control: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
    },
    element,
  });
}
// Trusted browser input is included. CDP-generated input is also trusted, so
// origin remains unknown; page-dispatched synthetic clicks are excluded.
window.addEventListener("click", recordActivation, { capture: true });
window.addEventListener("auxclick", recordActivation, { capture: true });

ipcRenderer.on(RECORDING_STATE_CHANNEL, (_event, enabled: unknown) => {
  recordingEnabled = enabled === true;
  if (recordingEnabled)
    ipcRenderer.send(
      RECORDING_HELLO_CHANNEL,
      recordingNonce ? { nonce: recordingNonce } : { unavailable: true },
    );
});
ipcRenderer.send(
  RECORDING_HELLO_CHANNEL,
  recordingNonce
    ? { nonce: recordingNonce, requestState: true }
    : { unavailable: true, requestState: true },
);

let browserId: string | null = null;
let policy: BrowserShortcutPrefix[] = [];

interface BrowserKeyboardPolicyPayload extends BrowserKeyboardPolicy {
  browserId: string;
}

function matchesPolicy(event: KeyboardEvent): boolean {
  const editable = isEditableTarget(event.target);
  return policy.some((prefix) => {
    if (
      prefix.alt !== event.altKey ||
      prefix.control !== event.ctrlKey ||
      prefix.meta !== event.metaKey ||
      prefix.shift !== event.shiftKey ||
      (prefix.editable === false && editable) ||
      (prefix.repeat === false && event.repeat)
    ) {
      return false;
    }
    if (prefix.key === undefined) {
      return matchesCode(prefix.code, event.code);
    }
    const eventKey = event.key.toLowerCase();
    if (eventKey === prefix.key) {
      return true;
    }
    if (prefix.shift && prefix.shiftedKey !== undefined && eventKey === prefix.shiftedKey) {
      return true;
    }
    return (prefix.alt || prefix.codeFallback === true) && matchesCode(prefix.code, event.code);
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const element = target as HTMLElement;
  if (element.isContentEditable) {
    return true;
  }
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

function matchesCode(prefixCode: string, eventCode: string): boolean {
  if (prefixCode !== "Digit") {
    return prefixCode === eventCode;
  }
  return /^(?:Digit|Numpad)[1-9]$/.test(eventCode);
}

function stageShortcutForward(event: KeyboardEvent): void {
  if (!event.isTrusted || event.defaultPrevented || !browserId || !matchesPolicy(event)) {
    return;
  }

  const shortcutBrowserId = browserId;
  window.addEventListener(
    "keydown",
    (completedEvent) => {
      if (completedEvent !== event || completedEvent.defaultPrevented) {
        return;
      }
      completedEvent.preventDefault();
      ipcRenderer.send(SHORTCUT_INPUT_CHANNEL, {
        alt: completedEvent.altKey,
        browserId: shortcutBrowserId,
        code: completedEvent.code,
        control: completedEvent.ctrlKey,
        key: completedEvent.key,
        meta: completedEvent.metaKey,
        repeat: completedEvent.repeat,
        shift: completedEvent.shiftKey,
      });
    },
    { once: true },
  );
}

window.addEventListener("keydown", stageShortcutForward, { capture: true });

ipcRenderer.on(POLICY_CHANNEL, (_event, value: BrowserKeyboardPolicyPayload) => {
  if (!value || typeof value.browserId !== "string" || !Array.isArray(value.prefixes)) {
    return;
  }
  browserId = value.browserId;
  policy = value.prefixes;
});

ipcRenderer.send(POLICY_REQUEST_CHANNEL);
