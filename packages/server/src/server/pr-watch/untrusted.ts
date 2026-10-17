/** Cap per untrusted block, so a huge log or comment can't crowd out the rest of the prompt. */
const MAX_UNTRUSTED_CHARS = 8_000;

/**
 * Wraps text from outside the user's control (CI output, PR comments, PR
 * titles) in a delimited block. The text can't close the block early and pose
 * as instructions.
 */
export function wrapUntrusted(params: {
  tag: string;
  attribute?: string;
  notice: string;
  text: string;
}): string[] {
  const { tag } = params;
  const body = truncate(params.text, MAX_UNTRUSTED_CHARS).replaceAll(`</${tag}`, `<\\/${tag}`);
  const open = params.attribute ? `<${tag} ${params.attribute}>` : `<${tag}>`;
  return [open, params.notice, body, `</${tag}>`];
}

export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}
