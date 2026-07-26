export const LONG_RESPONSE_CHAR_LIMIT = 8_000;
export const LONG_RESPONSE_LINE_LIMIT = 120;
export const RESPONSE_PREVIEW_CHAR_LIMIT = 6_000;
export const RESPONSE_PREVIEW_LINE_LIMIT = 90;

export interface TranscriptPreview {
  text: string;
  truncated: boolean;
  hiddenCharacters: number;
  hiddenLines: number;
}

export function createTranscriptPreview(text: string): TranscriptPreview {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const shouldCollapse =
    text.length > LONG_RESPONSE_CHAR_LIMIT ||
    lines.length > LONG_RESPONSE_LINE_LIMIT;

  if (!shouldCollapse) {
    return {
      text,
      truncated: false,
      hiddenCharacters: 0,
      hiddenLines: 0,
    };
  }

  const lineCut =
    lines.length > RESPONSE_PREVIEW_LINE_LIMIT
      ? lines.slice(0, RESPONSE_PREVIEW_LINE_LIMIT).join("\n").length
      : text.length;
  let cut = Math.min(text.length, RESPONSE_PREVIEW_CHAR_LIMIT, lineCut);

  // Prefer a complete line near the size boundary without throwing away a
  // large part of the useful preview.
  const lastLineBreak = text.lastIndexOf("\n", cut);
  if (lastLineBreak >= cut * 0.72) cut = lastLineBreak;

  const previewText = text.slice(0, cut).trimEnd();
  const shownLines =
    previewText.length === 0 ? 0 : previewText.split("\n").length;

  return {
    text: previewText,
    truncated: true,
    hiddenCharacters: Math.max(0, text.length - previewText.length),
    hiddenLines: Math.max(0, lines.length - shownLines),
  };
}
