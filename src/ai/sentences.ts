/**
 * Streaming sentence splitter (pure, unit-tested). The LLM emits tokens;
 * TTS wants whole sentences to sound right. pullSentences() carves every
 * complete sentence off the front of the buffer and keeps the tail.
 * Abbreviations ("Dr.") may split early — acceptable for a toy; the tail
 * rejoins them at flush time only if no terminator follows. Keep fragments
 * short-safe: single words without terminators never emit.
 */
export function pullSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  for (;;) {
    const m = rest.match(/^([^.!?…]*[.!?…]["'”’)]?)([\s]+|$)/);
    if (!m) break;
    const sentence = m[1].trim();
    if (sentence.length === 0) break;
    sentences.push(sentence);
    rest = rest.slice(m[0].length);
  }
  return { sentences, rest };
}
