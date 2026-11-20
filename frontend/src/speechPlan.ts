export type MouthShape =
  | "neutral"
  | "smile"
  | "open"
  | "o_shape"
  | "talk"
  | "teeth_clench"
  | "ah"
  | "kiss"
  | "surprised";

export interface SpeechChunk {
  text: string;
  start: number;
}

export interface SpeechWord {
  text: string;
  start: number;
  end: number;
}

export interface CompleteSpeechSentences {
  sentences: string[];
  nextOffset: number;
}

export function cleanSpeechText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/^\s*(?:\d+[.)]|[-+•])\s+/gmu, "")
    .replace(/^\s*\|?\s*[-:]+[-:| ]*\|?\s*$/gmu, "")
    .replace(/\|/gu, " ")
    .replace(/[*_~`#>]/gu, "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0E\uFE0F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function splitSpeechText(text: string, maximumLength = 180): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maximumLength, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const sentenceBreaks = [...slice.matchAll(/[.!?。！？](?=\s|$)/gu)];
      const sentenceBreak = sentenceBreaks[sentenceBreaks.length - 1];
      if (sentenceBreak?.index !== undefined && sentenceBreak.index >= maximumLength / 2) {
        end = start + sentenceBreak.index + 1;
      } else {
        const space = text.lastIndexOf(" ", end - 1);
        if (space > start) end = space + 1;
      }
    }

    chunks.push({ text: text.slice(start, end), start });
    start = end;
  }

  return chunks;
}

export function extractCompleteSentences(
  text: string,
  fromOffset: number,
  includeRemainder = false,
  fallbackLength = 60,
): CompleteSpeechSentences {
  const sentences: string[] = [];
  let cursor = Math.max(0, Math.min(fromOffset, text.length));

  while (cursor < text.length) {
    let boundary = -1;
    for (let index = cursor; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\n") {
        boundary = index + 1;
        break;
      }
      if (/[.!?。！？]/u.test(character) && (
        index + 1 === text.length || /\s/u.test(text[index + 1])
      )) {
        boundary = index + 1;
        break;
      }
    }
    if (boundary < 0) {
      for (let index = cursor; index < text.length; index += 1) {
        if (/[，,]/u.test(text[index])) {
          boundary = index + 1;
          break;
        }
      }
      if (boundary < 0 && text.length - cursor >= fallbackLength) {
        const limit = Math.min(text.length, cursor + fallbackLength);
        const whitespace = text.lastIndexOf(" ", limit);
        if (whitespace > cursor) boundary = whitespace;
      }
    }
    if (boundary < 0) {
      if (includeRemainder) {
        const remainder = text.slice(cursor).trim();
        if (remainder) sentences.push(remainder);
        cursor = text.length;
      }
      break;
    }

    const sentence = text.slice(cursor, boundary).trim();
    if (sentence) sentences.push(sentence);
    cursor = boundary;
    while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
  }

  return { sentences, nextOffset: cursor };
}

export function speechWords(text: string): SpeechWord[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    text: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

export function mouthForLetter(word: string, index: number): MouthShape {
  const letters = Array.from(word);
  const letter = (letters[index] || "").toLocaleLowerCase();
  let lastVowel = -1;
  letters.forEach((character, characterIndex) => {
    if (/[aeiou]/iu.test(character)) lastVowel = characterIndex;
  });

  if (/[aeiou]/iu.test(letter) && index === lastVowel) return "open";
  if (letter === "a") return "ah";
  if (letter === "e" || letter === "i") return "talk";
  if (letter === "o") return "o_shape";
  if (letter === "u") return "kiss";
  if (/[mbp]/u.test(letter)) return "neutral";
  if (/[fvsztd]/u.test(letter)) return "teeth_clench";
  return "talk";
}
