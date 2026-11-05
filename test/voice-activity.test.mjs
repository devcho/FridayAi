import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceActivity } from '../public/voice-activity.js';

test('a short wake word spoken immediately after recording starts is detected', () => {
  const activity = createVoiceActivity();
  assert.equal(activity.sample(.08, 0), null);
  assert.equal(activity.sample(.08, 100), null);
  assert.equal(activity.sample(.08, 200), null);
  assert.equal(activity.sample(.002, 1100), null);
  assert.equal(activity.sample(.002, 1200), 'speech-ended');
});

test('recording ends after speech followed by silence and allows pauses within a sentence', () => {
  const activity = createVoiceActivity();
  assert.equal(activity.sample(.002, 0), null);
  assert.equal(activity.sample(.08, 200), null);
  assert.equal(activity.sample(.08, 400), null);
  assert.equal(activity.sample(.002, 1300), null);
  assert.equal(activity.sample(.08, 1450), null);
  assert.equal(activity.sample(.08, 1600), null);
  assert.equal(activity.sample(.002, 2400), null);
  assert.equal(activity.sample(.002, 2600), 'speech-ended');
});

test('silence is discarded instead of being sent to speech recognition', () => {
  const activity = createVoiceActivity();
  for (let now = 0; now < 15000; now += 200) assert.equal(activity.sample(.003, now), null);
  assert.equal(activity.sample(.003, 15000), 'quiet');
});

test('steady microphone noise does not keep recording as speech', () => {
  const activity = createVoiceActivity();
  for (let now = 0; now < 15000; now += 200) assert.equal(activity.sample(.018, now), null);
  assert.equal(activity.sample(.018, 15000), 'quiet');
});

test('recording stops after speech even when low background noise remains', () => {
  const activity = createVoiceActivity();
  for (let now = 0; now <= 600; now += 200) assert.equal(activity.sample(.004, now), null);
  assert.equal(activity.sample(.08, 800), null);
  assert.equal(activity.sample(.08, 1000), null);
  assert.equal(activity.sample(.022, 1800), null);
  assert.equal(activity.sample(.022, 2000), 'speech-ended');
});
