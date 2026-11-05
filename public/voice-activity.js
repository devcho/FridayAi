export function createVoiceActivity({ silenceMs = 1000, waitMs = 15000, warmupMs = 600 } = {}) {
  let started = null, lastSpeech = null, speechFrames = 0, noise = 0.006, speechPeak = 0;
  return {
    sample(level, now) {
      if (started === null) started = now;
      const elapsed = now - started;
      if (lastSpeech === null && elapsed <= warmupMs && level < 0.026) {
        noise = noise * 0.85 + Math.min(level, 0.025) * 0.15;
        return null;
      }
      const threshold = Math.max(0.026, Math.min(0.06, noise * 2.6 + 0.008), speechPeak ? Math.min(0.06, speechPeak * 0.48) : 0);
      if (level >= threshold) {
        speechPeak = Math.max(speechPeak, level);
        speechFrames++; if (speechFrames >= 2) lastSpeech = now;
        return null;
      } else {
        speechFrames = 0;
        if (lastSpeech === null) noise = noise * 0.92 + Math.min(level, 0.025) * 0.08;
      }
      if (lastSpeech !== null && now - lastSpeech >= silenceMs) return 'speech-ended';
      if (lastSpeech === null && now - started >= waitMs) return 'quiet';
      return null;
    },
  };
}
