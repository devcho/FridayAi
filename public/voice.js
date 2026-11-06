import { speechChunks } from './speech-text.js';
import { addressedText } from './wake-word.js';
import { createVoiceActivity } from './voice-activity.js';

export function createVoiceChat({ token, notify, onTranscript, onSend }) {
  const $ = selector => document.querySelector(selector);
  const composer = $('#chat-form');
  const originalPlaceholder = $('#prompt').placeholder;
  const microphoneSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  let capabilities = null, chatBusy = false, captureState = 'idle', captureEpoch = 0;
  let recording = null, transcription = null, playback = null, playbackEpoch = 0, currentAudio = null, currentReadButton = null;
  let speechContext = null, speechSource = null, continuousArmed = false, listenTimer = null, voiceActive = false, voiceReplyPending = false, autoListening = false, autoListenAttempted = false;
  let wakeAccepted = false, speechWarmTimer = null, speechWarming = null;
  for (const [id, key] of [['#voice-auto-listen', 'fridayAutoListen'], ['#voice-auto-stop', 'fridayAutoStop'], ['#voice-continuous', 'fridayContinuous'], ['#voice-auto-send', 'fridayAutoSend'], ['#voice-auto-read', 'fridayAutoRead']]) {
    try { const saved = window.localStorage?.getItem(key); if (saved !== null && saved !== undefined) $(id).checked = saved === 'true'; } catch {}
    $(id).addEventListener('change', () => {
      try { window.localStorage?.setItem(key, String($(id).checked)); } catch {}
      if (id === '#voice-continuous' && !$(id).checked) { continuousArmed = false; wakeAccepted = false; clearTimeout(listenTimer); update(); }
      if (id === '#voice-auto-listen') {
        autoListenAttempted = false;
        if ($(id).checked) maybeAutoListen();
        else if (autoListening) { stopAll(); status('자동 호출 대기를 껐습니다.'); }
      }
    });
  }

  async function unlockSpeech() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    if (!speechContext || speechContext.state === 'closed') speechContext = new Context();
    if (speechContext.state === 'suspended') {
      let timer;
      try { await Promise.race([speechContext.resume(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('음성 재생을 허용하려면 답변의 ‘답변 듣기’를 눌러 주세요.')), 2500); })]); }
      finally { clearTimeout(timer); }
    }
    return speechContext;
  }
  function listenNext() {
    clearTimeout(listenTimer);
    if (!voiceActive || !continuousArmed || chatBusy || playback || captureState !== 'idle') return;
    listenTimer = setTimeout(() => { if (voiceActive && continuousArmed && !chatBusy && !playback && captureState === 'idle') void startRecording({ unlock: !autoListening }); }, 100);
  }

  function armContinuous() {
    continuousArmed = true;
    $('#voice-continuous').checked = true;
    try { window.localStorage?.setItem('fridayContinuous', 'true'); } catch {}
  }

  function status(message) { $('#voice-status').textContent = message; $('#voice-status-row').hidden = !message; }
  function update() {
    composer.dataset.voiceState = playback ? 'speaking' : captureState;
    $('#voice-toggle').disabled = !voiceActive && (!capabilities?.installed || !microphoneSupported || chatBusy);
    $('#voice-toggle').setAttribute('aria-pressed', String(voiceActive));
    $('#voice-toggle').setAttribute('aria-label', voiceActive ? '음성 입력 종료' : '음성 입력 시작');
    $('#voice-toggle').title = voiceActive ? '음성 입력 종료' : '음성 입력 시작';
    $('#voice-mic-icon').hidden = voiceActive; $('#voice-stop-icon').hidden = !voiceActive;
    $('#prompt').placeholder = captureState === 'recording' ? '듣고 있어요. 말을 마치면 자동으로 전송합니다…' : originalPlaceholder;
    $('#voice-submit').hidden = captureState !== 'recording';
    $('#voice-cancel').hidden = captureState === 'idle';
    $('#voice-upload').disabled = !capabilities?.installed || chatBusy || captureState !== 'idle';
    $('#voice-language').disabled = captureState !== 'idle';
    $('#voice-stop-speaking').hidden = !playback;
    $('#voice-end').hidden = !voiceActive;
  }
  async function request(endpoint, { json, audio, signal } = {}) {
    const response = await fetch(endpoint, {
      method: json !== undefined || audio ? 'POST' : 'GET', signal,
      headers: { 'x-app-token': token, ...(json !== undefined ? { 'Content-Type': 'application/json' } : audio ? { 'Content-Type': audio.type || 'application/octet-stream' } : {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : audio ? { body: audio } : {}),
    });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || '음성 작업을 처리하지 못했습니다.'); }
    return response;
  }
  async function refreshCapabilities() {
    capabilities = await (await request('/api/voice/status')).json();
    if (capabilities.assistant) $('#voice-wake-hint').textContent = capabilities.assistant.requireWakeWord ? `처음에 ‘${capabilities.assistant.name}’를 부르면 음성 대화를 종료할 때까지 이름을 생략할 수 있습니다.` : '이름을 부르지 않아도 말한 내용을 전달합니다.';
    const engines = capabilities.speechEngines || [{ id: 'windows', name: '기본 음성 · 빠름', available: capabilities.canSpeak }];
    let preferred;
    try { preferred = window.localStorage?.getItem('localMateSpeechEngine'); } catch {}
    const selected = engines.some(engine => engine.id === preferred && engine.available) ? preferred : capabilities.speechEngine || 'windows';
    $('#voice-engine').replaceChildren();
    for (const engine of engines) {
      const option = document.createElement('option'); option.value = engine.id; option.textContent = engine.name + (engine.available ? '' : ' · 설치 필요'); option.disabled = !engine.available;
      $('#voice-engine').append(option);
    }
    $('#voice-engine').value = selected;
    if (!capabilities.installed) status('음성 인식 설치가 필요합니다. 프로젝트 폴더의 setup-voice.cmd를 실행해 주세요.');
    else if (!microphoneSupported) status('이 브라우저는 마이크 녹음을 지원하지 않습니다. 음성 파일을 선택하거나 Chrome·Edge에서 열어 주세요.');
    else if (!capabilities.canSpeak) status('말하기를 사용할 수 있습니다. 답변 읽기에는 Windows 한국어 음성 설치가 필요합니다.');
    update(); return capabilities;
  }

  async function prepareSpeech() {
    if ($('#voice-engine').value !== 'neural') return;
    if (speechWarming) return speechWarming;
    speechWarming = warmSpeech().finally(() => { speechWarming = null; });
    return speechWarming;
  }
  function keepSpeechWarm() {
    clearInterval(speechWarmTimer);
    speechWarmTimer = setInterval(() => {
      if (voiceActive && $('#voice-auto-read').checked && $('#voice-engine').value === 'neural' && !playback) void prepareSpeech();
    }, 60000);
  }
  async function warmSpeech() {
    try {
      await request('/api/voice/warm-speech', { json: { engine: 'neural' } });
      if (voiceActive && $('#voice-engine').value === 'neural' && !playback && !chatBusy && captureState === 'idle') status('자연스러운 한국어 목소리가 준비됐습니다.');
    } catch (error) { if (voiceActive && $('#voice-engine').value === 'neural' && captureState === 'idle') status(`${error.message} 설정에서 기본 음성을 선택할 수도 있습니다.`); }
  }

  function releaseRecording(session) {
    clearInterval(session?.timer);
    session?.stream?.getTracks().forEach(track => track.stop());
    session?.audioSource?.disconnect?.(); session?.analyser?.disconnect?.();
    if (session?.ownsContext) session.context.close().catch(() => {});
    $('#voice-level').hidden = true; $('#voice-level').value = 0; $('#voice-timer').textContent = '';
  }
  function cancelInput() {
    captureEpoch++;
    transcription?.abort(); transcription = null;
    const session = recording; recording = null;
    if (session) {
      session.discard = true;
      if (session.recorder?.state !== 'inactive') { try { session.recorder.stop(); } catch {} }
      releaseRecording(session);
    }
    captureState = 'idle'; update();
  }
  function stopSpeaking() {
    playbackEpoch++;
    playback?.abort(); playback = null;
    if (speechSource) { try { speechSource.stop(); } catch {} speechSource = null; }
    if (currentAudio) { currentAudio.pause(); currentAudio.removeAttribute('src'); currentAudio.load(); currentAudio = null; }
    if (currentReadButton) { currentReadButton.textContent = '▷ 답변 듣기'; currentReadButton.setAttribute('aria-pressed', 'false'); currentReadButton = null; }
    update();
  }
  function stopAll() { clearInterval(speechWarmTimer); speechWarmTimer = null; voiceActive = false; voiceReplyPending = false; autoListening = false; wakeAccepted = false; continuousArmed = false; clearTimeout(listenTimer); cancelInput(); stopSpeaking(); status(''); }

  async function recognize(audio) {
    if (chatBusy || captureState === 'transcribing') return;
    const epoch = ++captureEpoch;
    let submitted = false;
    if (audio.size > (capabilities?.maxAudioBytes || 8 * 1024 * 1024)) return notify('음성 파일은 8MB 이하여야 합니다.');
    if (audio.size < 100) return notify('녹음된 음성이 없습니다. 조금 더 길게 말씀해 주세요.');
    stopSpeaking();
    transcription = new AbortController(); captureState = 'transcribing'; status('음성을 글자로 바꾸고 있습니다…'); update();
    try {
      const response = await request(`/api/voice/transcribe?language=${encodeURIComponent($('#voice-language').value)}`, { audio, signal: transcription.signal });
      const result = await response.json();
      if (epoch !== captureEpoch) return;
      captureState = 'idle'; transcription = null; update();
      const inConversation = voiceActive && continuousArmed && wakeAccepted;
      if (!result.text?.trim()) {
        if (inConversation) { status('말소리를 기다리고 있습니다. 종료 버튼으로 대화를 마칠 수 있습니다.'); listenNext(); return; }
        if (autoListening) { status(`‘${capabilities?.assistant?.name || '프라이데이'}’ 호출을 기다리고 있습니다.`); listenNext(); return; }
        continuousArmed = false; voiceActive = false; status('말소리를 찾지 못했습니다. 마이크를 가까이 두고 다시 말씀해 주세요.'); return;
      }
      const addressed = addressedText(result.text, { ...(capabilities?.assistant || {}), requireWakeWord: !inConversation && (autoListening || Boolean(capabilities?.assistant?.requireWakeWord)) });
      if (!addressed.addressed) {
        if (autoListening) { status(`인식: ${result.text.slice(0, 90)} · ‘${capabilities?.assistant?.name || '프라이데이'}’ 호출을 기다리고 있습니다.`); listenNext(); return; }
        continuousArmed = false; voiceActive = false; status(`인식: ${result.text.slice(0, 90)} · ‘${capabilities?.assistant?.name || '프라이데이'}’로 시작하지 않아 전송하지 않았습니다.`); return;
      }
      wakeAccepted = voiceActive && continuousArmed;
      if (!addressed.text) {
        const fastEngine = capabilities?.speechEngines?.some(engine => engine.id === 'windows' && engine.available) ? 'windows' : undefined;
        if ($('#voice-auto-read').checked && capabilities?.canSpeak) { void speak('네, 말씀하세요.', null, { engine: fastEngine }); return; }
        status('네, 말씀하세요.'); listenNext(); return;
      }
      onTranscript(addressed.text);
      status(`인식한 내용: ${result.text.slice(0, 90)}${result.text.length > 90 ? '…' : ''}`);
      voiceReplyPending = true;
      if ($('#voice-auto-send').checked) {
        submitted = true;
        Promise.resolve(onSend()).then(started => {
          if (started === false) {
            voiceReplyPending = false; continuousArmed = false; voiceActive = false; autoListening = false;
            status('인식한 내용은 입력창에 넣었지만 전송하지 못했습니다. 로컬 모델 연결을 확인한 뒤 전송을 눌러 주세요.');
            update();
          }
        }).catch(error => {
          voiceReplyPending = false; continuousArmed = false; voiceActive = false; autoListening = false;
          status(error.message || '인식한 내용을 전송하지 못했습니다.');
          notify(error.message || '인식한 내용을 전송하지 못했습니다.');
          update();
        });
      }
      else { continuousArmed = false; notify('인식한 내용을 입력창에서 확인하고 전송해 주세요.'); }
    } catch (error) {
      if (epoch === captureEpoch && error.name !== 'AbortError') { continuousArmed = false; voiceActive = false; autoListening = false; status(error.message); notify(error.message); }
    } finally { if (epoch === captureEpoch) { transcription = null; captureState = 'idle'; if (!continuousArmed && $('#voice-auto-send').checked) voiceActive = false; update(); if (submitted && chatBusy) listenNext(); } }
  }

  function stopRecording(discard = false) {
    const session = recording;
    if (!session) return;
    session.discard = discard;
    clearInterval(session.timer);
    if (session.recorder.state !== 'inactive') session.recorder.stop();
    session.stream.getTracks().forEach(track => track.stop());
  }
  async function startRecording({ unlock = true } = {}) {
    if (captureState === 'recording') return stopRecording();
    if (captureState !== 'idle' || chatBusy) return;
    if (!microphoneSupported) return notify('마이크 녹음을 지원하는 Chrome 또는 Edge에서 열어 주세요.');
    if (unlock) void unlockSpeech().catch(error => { status(error.message); notify(error.message); });
    stopSpeaking();
    const epoch = ++captureEpoch;
    captureState = 'requesting'; status('브라우저의 마이크 사용 권한을 확인해 주세요.'); update();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (epoch !== captureEpoch) { stream.getTracks().forEach(track => track.stop()); return; }
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!unlock && Context) {
        try { if (!speechContext || speechContext.state === 'closed') speechContext = new Context(); }
        catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
        if (speechContext.state !== 'running') {
          stream.getTracks().forEach(track => track.stop()); stopAll();
          status('호출 대기와 음성 응답을 시작하려면 마이크 버튼을 한 번 눌러 주세요.'); return;
        }
      }
      const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
      const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
      let recorder;
      try { recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 }); }
      catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
      const session = { stream, recorder, chunks: [], discard: false, started: Date.now(), bytes: 0, activity: createVoiceActivity({ minSpeechLevel: autoListening ? 0.016 : 0.026 }) };
      recording = session;
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          session.context = speechContext || new AudioContext(); session.ownsContext = session.context !== speechContext; session.context.resume().catch(() => {});
          session.analyser = session.context.createAnalyser(); session.analyser.fftSize = 256;
          session.audioSource = session.context.createMediaStreamSource(stream); session.audioSource.connect(session.analyser);
          session.wave = new Uint8Array(session.analyser.fftSize); $('#voice-level').hidden = false;
        }
      } catch { /* Recording also works without a volume meter. */ }
      recorder.ondataavailable = event => {
        if (event.data.size) { session.chunks.push(event.data); session.bytes += event.data.size; }
        if (session.bytes > (capabilities?.maxAudioBytes || 8 * 1024 * 1024)) { notify('녹음 크기 제한에 도달했습니다.'); stopRecording(true); }
      };
      recorder.onerror = () => { session.discard = true; notify('마이크 녹음에 실패했습니다.'); stopRecording(true); };
      recorder.onstop = () => {
        releaseRecording(session);
        if (recording === session) recording = null;
        if (epoch !== captureEpoch) return;
        captureState = 'idle'; update();
        if (!session.discard) void recognize(new Blob(session.chunks, { type: recorder.mimeType || 'audio/webm' }));
        else { status('말소리를 기다리고 있습니다. 마이크 버튼으로 종료할 수 있습니다.'); listenNext(); }
      };
      recorder.start(100); captureState = 'recording'; status($('#voice-auto-stop').checked && session.analyser ? '듣고 있어요 · 1초 조용하면 바로 전송' : '듣고 있어요 · 입력창의 음성 전송을 눌러 주세요'); update();
      session.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - session.started) / 1000);
        $('#voice-timer').textContent = `${seconds} / ${capabilities?.maxAudioSeconds || 60}초`;
        if (session.analyser) {
          session.analyser.getByteTimeDomainData(session.wave); let sum = 0; for (const sample of session.wave) sum += ((sample - 128) / 128) ** 2;
          const level = Math.sqrt(sum / session.wave.length); $('#voice-level').value = Math.min(1, level * 5);
          if ($('#voice-auto-stop').checked) { const ended = session.activity.sample(level, Date.now()); if (ended) return stopRecording(ended === 'quiet'); }
        }
        if (seconds >= (capabilities?.maxAudioSeconds || 60)) stopRecording();
      }, 100);
      void request('/api/voice/warm', { json: {} }).catch(() => {});
    } catch (error) {
      if (epoch !== captureEpoch) return;
      cancelInput();
      voiceActive = false; continuousArmed = false; autoListening = false; update();
      const message = error.name === 'NotAllowedError' && !unlock ? '자동 호출 대기를 켜려면 브라우저 주소창의 사이트 설정에서 마이크를 허용해 주세요.' : error.name === 'NotAllowedError' ? '마이크 권한이 필요합니다. 브라우저 주소창의 사이트 설정에서 마이크를 허용해 주세요.' : error.name === 'NotFoundError' ? '연결된 마이크를 찾지 못했습니다.' : `녹음을 시작하지 못했습니다: ${error.message}`;
      status(message); if (unlock) notify(message);
    }
  }

  async function playBlob(blob, signal) {
    const context = await unlockSpeech();
    if (context) {
      signal.throwIfAborted();
      const buffer = await context.decodeAudioData(await blob.arrayBuffer()); signal.throwIfAborted();
      const source = context.createBufferSource(); speechSource = source; source.buffer = buffer; source.connect(context.destination);
      try {
        await new Promise((resolve, reject) => {
          const finish = error => { source.onended = null; signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
          const abort = () => { try { source.stop(); } catch {} finish(new DOMException('취소됨', 'AbortError')); };
          source.onended = () => finish(); signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) return abort();
          try { source.start(); } catch (error) { finish(error); }
        });
      } finally { source.disconnect(); if (speechSource === source) speechSource = null; }
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url); currentAudio = audio;
    try {
      await new Promise((resolve, reject) => {
        const done = error => { signal.removeEventListener('abort', abort); audio.onended = audio.onerror = null; error ? reject(error) : resolve(); };
        const abort = () => { audio.pause(); done(new DOMException('취소됨', 'AbortError')); };
        audio.onended = () => done();
        audio.onerror = () => done(new Error('음성 재생에 실패했습니다.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) return abort();
        audio.play().catch(error => done(new Error(error.name === 'NotAllowedError' ? '자동 재생이 차단됐습니다. 답변의 ‘답변 듣기’를 눌러 주세요.' : error.message)));
      });
    } finally { if (currentAudio === audio) currentAudio = null; audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
  }
  async function speak(content, button, { engine: requestedEngine } = {}) {
    clearTimeout(listenTimer); cancelInput();
    stopSpeaking();
    const epoch = playbackEpoch;
    const controller = new AbortController(); playback = controller; currentReadButton = button || null;
    if (button) { button.textContent = '■ 읽기 중지'; button.setAttribute('aria-pressed', 'true'); }
    update();
    let succeeded = false;
    try {
      if (!capabilities) await refreshCapabilities();
      const engine = requestedEngine || $('#voice-engine').value || capabilities.speechEngine || 'windows';
      const chunks = speechChunks(content, engine === 'neural' ? capabilities.speechChunkCharacters || 160 : 700, engine === 'neural' ? { firstSize: 48 } : {});
      const generate = text => request('/api/voice/speak', { json: { text, engine }, signal: controller.signal })
        .then(response => response.blob()).then(blob => ({ blob }), error => ({ error }));
      let next = chunks.length ? generate(chunks[0]) : null;
      for (let index = 0; index < chunks.length; index++) {
        if (epoch !== playbackEpoch) return;
        status(engine === 'neural' ? '자연스러운 답변 음성을 만들고 있습니다… 준비가 끝나면 재생합니다.' : '답변 음성을 만들고 있습니다…');
        const result = await next;
        if (result.error) throw result.error;
        if (epoch !== playbackEpoch) return;
        next = index + 1 < chunks.length ? generate(chunks[index + 1]) : null;
        status('답변을 음성으로 읽고 있습니다.');
        await playBlob(result.blob, controller.signal);
      }
      succeeded = true;
      if (epoch === playbackEpoch) status('읽기를 마쳤습니다. 대화를 이어갈 수 있습니다.');
    } catch (error) { if (epoch === playbackEpoch && error.name !== 'AbortError') { stopAll(); status(`${error.message} 마이크 버튼을 눌러 다시 시작할 수 있습니다.`); notify(error.message); } }
    finally { if (epoch === playbackEpoch) { stopSpeaking(); if (succeeded) { if (!continuousArmed) { voiceActive = false; update(); } listenNext(); } } }
  }

  async function startVoiceSession({ automatic = false } = {}) {
    if (voiceActive || captureState !== 'idle') return false;
    wakeAccepted = false;
    voiceActive = true; autoListening = automatic; armContinuous(); update();
    if (!automatic) void unlockSpeech().catch(error => { status(error.message); notify(error.message); });
    try {
      if (!capabilities) await refreshCapabilities();
      if (!capabilities.installed || !microphoneSupported) { stopAll(); return; }
      keepSpeechWarm(); void prepareSpeech(); await startRecording({ unlock: !automatic });
    } catch (error) { stopAll(); status(error.message); notify(error.message); }
    return true;
  }

  function maybeAutoListen() {
    if (autoListenAttempted || voiceActive || captureState !== 'idle' || chatBusy || !$('#voice-auto-listen').checked) return;
    autoListenAttempted = true;
    void startVoiceSession({ automatic: true });
  }

  $('#voice-toggle').addEventListener('click', async () => {
    if (voiceActive || captureState !== 'idle') { stopAll(); status('음성 입력을 종료했습니다.'); return; }
    await startVoiceSession();
  });
  $('#voice-submit').addEventListener('click', () => stopRecording());
  $('#voice-cancel').addEventListener('click', () => { stopAll(); status('음성 입력을 취소했습니다.'); });
  $('#voice-end').addEventListener('click', () => { stopAll(); status('음성 대화를 중지하고 마이크를 껐습니다.'); });
  $('#voice-stop-speaking').addEventListener('click', () => { continuousArmed = false; stopSpeaking(); status('읽기를 중지했습니다.'); });
  $('#voice-auto-read').addEventListener('change', () => { try { window.localStorage?.setItem('fridayAutoRead', String($('#voice-auto-read').checked)); } catch {} if (!$('#voice-auto-read').checked) { stopSpeaking(); listenNext(); } });
  $('#voice-engine').addEventListener('change', () => {
    stopSpeaking();
    try { window.localStorage?.setItem('localMateSpeechEngine', $('#voice-engine').value); } catch {}
    if (voiceActive && $('#voice-engine').value === 'neural') { status('자연스러운 목소리를 준비하고 있습니다…'); void prepareSpeech(); }
    else if (voiceActive) status('빠른 기본 목소리로 변경했습니다.');
  });
  $('#voice-upload').addEventListener('click', () => { void unlockSpeech().catch(error => notify(error.message)); $('#voice-file').value = ''; $('#voice-file').click(); });
  $('#voice-file').addEventListener('change', () => { const file = $('#voice-file').files?.[0]; if (file) { $('#assistant-settings-dialog').close(); voiceActive = true; continuousArmed = false; void recognize(file); } });
  composer.addEventListener('keydown', event => { if (event.key === 'Escape' && (voiceActive || playback)) { event.preventDefault(); stopAll(); status('음성 입력을 종료했습니다.'); } });
  window.addEventListener('pagehide', () => { stopAll(); speechContext?.close().catch(() => {}); speechContext = null; });

  const ready = refreshCapabilities().then(result => { maybeAutoListen(); return result; }).catch(error => { status(error.message); return null; });

  return {
    setBusy(value) { chatBusy = value; update(); if (!value) { listenNext(); maybeAutoListen(); } },
    beforeSend() { clearTimeout(listenTimer); cancelInput(); stopSpeaking(); },
    stopAll,
    refresh: refreshCapabilities,
    ready,
    attachReply(row, content) {
      const actions = document.createElement('div'); actions.className = 'message-voice-actions';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'voice-read-button'; button.textContent = '▷ 답변 듣기'; button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => { void unlockSpeech().catch(error => notify(error.message)); if (currentReadButton === button) { continuousArmed = false; stopSpeaking(); } else void speak(content, button); });
      actions.append(button); row.append(actions);
    },
    maybeSpeak(content) {
      const shouldSpeak = (voiceActive || voiceReplyPending) && $('#voice-auto-read').checked && capabilities?.canSpeak;
      voiceReplyPending = false;
      if (shouldSpeak) void speak(content);
    },
  };
}
