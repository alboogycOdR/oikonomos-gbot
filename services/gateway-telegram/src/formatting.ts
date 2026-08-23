/**
 * Reused from the salvaged Telegram gateway formatting utility. Command
 * results are plain text, so this focused helper is the applicable portion.
 */
const MARKDOWN_V2_SPECIAL_CHARS = new Set([
  "_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!",
]);

export function escapeMarkdownV2(text: string): string {
  let output = "";
  for (const character of text) {
    output += MARKDOWN_V2_SPECIAL_CHARS.has(character) ? `\\${character}` : character;
  }
  return output;
}
