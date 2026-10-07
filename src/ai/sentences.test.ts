import { pullSentences } from './sentences';

describe('pullSentences', () => {
  test('two sentences split, tail kept', () => {
    const r = pullSentences('Hello world. How are you');
    expect(r.sentences).toEqual(['Hello world.']);
    expect(r.rest).toBe('How are you');
  });
  test('question + exclamation terminators', () => {
    const r = pullSentences('Really? Yes! Ok');
    expect(r.sentences).toEqual(['Really?', 'Yes!']);
    expect(r.rest).toBe('Ok');
  });
  test('no terminator emits nothing', () => {
    const r = pullSentences('just a fragment');
    expect(r.sentences).toEqual([]);
    expect(r.rest).toBe('just a fragment');
  });
  test('empty buffer', () => {
    expect(pullSentences('')).toEqual({ sentences: [], rest: '' });
  });
  test('incremental streaming across chunks', () => {
    let buf = '';
    const out: string[] = [];
    for (const chunk of ['The sky is', ' blue. It is', ' nice today.']) {
      buf += chunk;
      const r = pullSentences(buf);
      out.push(...r.sentences);
      buf = r.rest;
    }
    expect(out).toEqual(['The sky is blue.', 'It is nice today.']);
    expect(buf).toBe('');
  });
  test('trailing quote attaches to sentence', () => {
    const r = pullSentences('She said "hi." Then left');
    expect(r.sentences).toEqual(['She said "hi."']);
    expect(r.rest).toBe('Then left');
  });
});
