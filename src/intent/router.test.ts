import { route, type Intent } from './router';

function cmd(text: string) {
  const r = route(text);
  expect(r.type).toBe('command');
  return (r as { type: 'command'; command: never }).command as {
    kind: string;
    speed?: number;
    durationMs?: number;
  };
}

describe('router: motion commands', () => {
  test('go forward', () => expect(cmd('go forward')).toMatchObject({ kind: 'fwd' }));
  test('move ahead', () => expect(cmd('move ahead')).toMatchObject({ kind: 'fwd' }));
  test('please go straight', () => expect(cmd('please go straight')).toMatchObject({ kind: 'fwd' }));
  test('forword (Vosk misrecognition, lev 1)', () =>
    expect(cmd('forword')).toMatchObject({ kind: 'fwd' }));
  test('back up', () => expect(cmd('back up')).toMatchObject({ kind: 'back' }));
  test('reverse!', () => expect(cmd('reverse!')).toMatchObject({ kind: 'back' }));
  test('turn left', () => expect(cmd('turn left')).toMatchObject({ kind: 'left' }));
  test('left', () => expect(cmd('left')).toMatchObject({ kind: 'left' }));
  test('go right', () => expect(cmd('go right')).toMatchObject({ kind: 'right' }));
  test('rght (missing vowel, lev 1)', () => expect(cmd('rght')).toMatchObject({ kind: 'right' }));
  test('go to the left resolves to left, not go', () =>
    expect(cmd('go to the left')).toMatchObject({ kind: 'left' }));
  test('bare go drives forward', () => expect(cmd('go')).toMatchObject({ kind: 'fwd' }));
  test('hey wii go forward strips wake', () =>
    expect(cmd('hey wii go forward')).toMatchObject({ kind: 'fwd' }));
});

describe('router: stop + priority', () => {
  test('stop', () => expect(cmd('stop')).toMatchObject({ kind: 'stop' }));
  test('halt!', () => expect(cmd('halt!')).toMatchObject({ kind: 'stop' }));
  test('freeze', () => expect(cmd('freeze')).toMatchObject({ kind: 'stop' }));
  test('wait', () => expect(cmd('wait')).toMatchObject({ kind: 'stop' }));
  test('SHOUTED + punctuation', () => expect(cmd('STOP!!!')).toMatchObject({ kind: 'stop' }));
  test('stob (typo, lev 1)', () => expect(cmd('stob')).toMatchObject({ kind: 'stop' }));
  test('stop beats motion: stop moving forward', () =>
    expect(cmd('stop moving forward')).toMatchObject({ kind: 'stop' }));
  test('top is NOT stop (short words exact-only)', () =>
    expect(route('top').type).not.toBe('command'));
});

describe('router: fun + speed + duration', () => {
  test('dance -> wiggle', () => expect(cmd('dance!')).toMatchObject({ kind: 'wiggle' }));
  test('spin around -> wiggle', () => expect(cmd('spin around')).toMatchObject({ kind: 'wiggle' }));
  test('wiggle', () => expect(cmd('wiggle')).toMatchObject({ kind: 'wiggle' }));
  test('go faster -> fwd @85', () =>
    expect(cmd('go faster')).toMatchObject({ kind: 'fwd', speed: 85 }));
  test('slowly go back -> back @30', () =>
    expect(cmd('slowly go back')).toMatchObject({ kind: 'back', speed: 30 }));
  test('bare faster -> speed cmd', () =>
    expect(cmd('faster')).toMatchObject({ kind: 'speed', speed: 85 }));
  test('bare slower -> speed cmd', () =>
    expect(cmd('slower')).toMatchObject({ kind: 'speed', speed: 30 }));
  test('speed 70 -> explicit value', () =>
    expect(cmd('speed 70')).toMatchObject({ kind: 'speed', speed: 70 }));
  test('go forward a little -> short burst', () =>
    expect(cmd('go forward a little')).toMatchObject({ kind: 'fwd', durationMs: 1200 }));
  test('a bit to the left', () =>
    expect(cmd('a bit to the left')).toMatchObject({ kind: 'left', durationMs: 1200 }));
});

describe('router: negation safety (MUST NOT move)', () => {
  test("don't go forward -> question, never fwd", () => {
    const r: Intent = route("don't go forward");
    expect(r.type).toBe('question');
  });
  test('do not move -> question', () => expect(route('do not move').type).toBe('question'));
  test('never go there -> question', () => expect(route('never go there').type).toBe('question'));
  test("don't stop -> none (must NOT stop either)", () =>
    expect(route("don't stop").type).toBe('none'));
  test('i want candy -> question (want != wait)', () =>
    expect(route('i want candy').type).toBe('question'));
});

describe('router: questions', () => {
  test('what time is it', () =>
    expect(route('what time is it')).toEqual({ type: 'question', text: 'what time is it' }));
  test('how are you today robot', () =>
    expect(route('how are you today robot').type).toBe('question'));
  test('why is the sky blue', () => expect(route('why is the sky blue').type).toBe('question'));
  test('tell me a joke', () => expect(route('tell me a joke').type).toBe('question'));
});

describe('router: noise -> none', () => {
  test('empty', () => expect(route('').type).toBe('none'));
  test('spaces', () => expect(route('   ').type).toBe('none'));
  test('hello', () => expect(route('hello').type).toBe('none'));
  test('uh (filler only)', () => expect(route('uh').type).toBe('none'));
  test('[unk] grammar collapse', () => expect(route('[unk]').type).toBe('none'));
  test('banana (unknown single word)', () => expect(route('banana').type).toBe('none'));
  test('no (bare negation, 1 word)', () => expect(route('no').type).toBe('none'));
});
