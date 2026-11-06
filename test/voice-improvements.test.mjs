import test from 'node:test';
import assert from 'node:assert/strict';
import { addressedText } from '../public/wake-word.js';
import { speechChunks, speechText } from '../public/speech-text.js';
import { createVoiceActivity } from '../public/voice-activity.js';

test('known Friday recognition variants preserve the following request', () => {
  for (const name of ['프라이데이', '프라이 데이', '후라이데이', '후 라이 데 이', '프라이데', 'Friday', '프라이데이야']) {
    assert.deepEqual(addressedText(`${name}, 오늘 날씨 알려줘`), { addressed: true, text: '오늘 날씨 알려줘' });
    assert.deepEqual(addressedText(name), { addressed: true, text: '' });
  }
  for (const text of ['오늘은 프라이데이', '후라이팬 꺼내줘', '프라이버시 설정', '다른 사람과 대화']) assert.equal(addressedText(text).addressed, false);
  assert.equal(addressedText('후라이데이, 안녕', { name: '시온' }).addressed, false);
  assert.deepEqual(addressedText('시 온, 안녕', { name: '시온' }), { addressed: true, text: '안녕' });
});

test('natural speech starts with a short sentence and retains all remaining content', () => {
  const text = '첫 문장입니다. ' + '자연스러운 음성으로 긴 답변을 읽습니다. 😀 '.repeat(20);
  const chunks = speechChunks(text, 160, { firstSize: 48 });
  assert.equal(chunks[0], '첫 문장입니다.');
  assert.ok(chunks[0].length <= 48);
  assert.ok(chunks.every(chunk => chunk.length <= 160));
  assert.equal(chunks.join('').replace(/\s/g, ''), speechText(text).replace(/\s/g, ''));
  const unbroken = speechChunks('가'.repeat(47) + '😀' + '나'.repeat(200), 160, { firstSize: 48 });
  assert.equal(unbroken.join(''), '가'.repeat(47) + '😀' + '나'.repeat(200));
  assert.ok(!/[\uD800-\uDBFF]$/.test(unbroken[0]));
  const greeting = '안녕하세요. 오늘은 어떤 작업을 함께 해 볼까요?';
  assert.deepEqual(speechChunks(greeting, 160, { firstSize: 48 }), ['안녕하세요.', '오늘은 어떤 작업을 함께 해 볼까요?']);
  assert.deepEqual(speechChunks(greeting), [greeting]);
});

test('sensitive wake detection catches a quiet short call and discards low steady noise', () => {
  const activity = createVoiceActivity({ minSpeechLevel: .016 });
  assert.equal(activity.sample(.020, 0), null);
  assert.equal(activity.sample(.020, 100), null);
  assert.equal(activity.sample(.002, 1100), 'speech-ended');
  const noise = createVoiceActivity({ minSpeechLevel: .016 });
  for (let now = 0; now < 15000; now += 100) assert.equal(noise.sample(.008, now), null);
  assert.equal(noise.sample(.008, 15000), 'quiet');
});
