'use strict';
import { createVoiceChat } from './voice.js';
const $ = selector => document.querySelector(selector);
const token = $('meta[name="app-token"]').content;
let busy = false, connected = false, currentDirectory = '.', startedAt = 0, elapsedTimer, toastTimer, pendingId = null;
const transcript = [];
const toolCards = [];
let voiceChat = null, assistant = { name: '프라이데이', requireWakeWord: true }, previewPath = null;
const labels = { list_directory: '폴더 살펴보기', read_file: '파일 읽기', read_document: '문서 읽기', create_document: '문서 만들기', search_files: '코드 검색', write_file: '파일 저장', run_command: '명령 실행', system_info: '시스템 확인', open_path: '탐색기 열기' };
const documentExtension = /\.(docx|xlsx|pptx|hwpx|hwp)$/i;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function api(endpoint, input) {
  const response = await fetch(endpoint, { method: input === undefined ? 'GET' : 'POST', headers: { 'x-app-token': token, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '요청을 처리하지 못했습니다.');
  return result;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function scrollDown() { const pane = $('#conversation'); pane.scrollTop = pane.scrollHeight; }
function showConversation() { $('#welcome').hidden = true; }
function appendProse(parent, text) {
  const paragraph = element('div', 'prose');
  const pieces = text.split(/(\*\*[^*]+\*\*)/g);
  for (const piece of pieces) {
    if (piece.startsWith('**') && piece.endsWith('**')) paragraph.append(element('strong', '', piece.slice(2, -2)));
    else paragraph.append(document.createTextNode(piece));
  }
  parent.append(paragraph);
}
function renderText(parent, content) {
  const expression = /```([^\n`]*)\n([\s\S]*?)```/g;
  let end = 0, match;
  while ((match = expression.exec(content))) {
    if (match.index > end) appendProse(parent, content.slice(end, match.index));
    const block = element('div', 'code-block');
    const header = element('div', 'code-header');
    header.append(element('span', '', match[1].trim() || 'code'));
    const copy = element('button', 'copy-button', '복사');
    const code = match[2];
    copy.type = 'button'; copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(code); toast('코드를 복사했습니다.'); } catch { toast('브라우저에서 복사 권한을 확인해 주세요.'); } });
    header.append(copy); block.append(header, element('pre', '', code)); parent.append(block);
    end = expression.lastIndex;
  }
  if (end < content.length) appendProse(parent, content.slice(end));
}
function addMessage(role, content, metrics) {
  showConversation();
  const row = element('article', `message ${role}`);
  const label = element('div', 'message-label');
  if (role !== 'user') label.append(element('span', 'avatar', 'm'));
  label.append(element('span', '', role === 'user' ? 'YOU' : role === 'error' ? '알림' : assistant.name));
  const body = element('div', 'message-body'); renderText(body, content);
  row.append(label, body);
  if (metrics?.tokensPerSecond) row.append(element('div', 'message-metrics', `${metrics.seconds}초 · ${metrics.tokensPerSecond} tokens/s · 로컬 생성`));
  if (role === 'assistant') voiceChat?.attachReply(row, content);
  $('#messages').append(row); transcript.push({ role, content }); scrollDown();
}
function addTool(event) {
  showConversation();
  const card = element('details', 'tool-card');
  const summary = element('summary');
  summary.append(element('span', '', labels[event.name] || event.name), element('span', 'tool-path', event.arguments?.path || event.arguments?.query || ''));
  const state = element('span', 'tool-state', '진행 중'); summary.append(state);
  const output = element('pre', '', '결과를 기다리고 있습니다.');
  card.append(summary, output); $('#messages').append(card);
  toolCards.push({ name: event.name, card, output, state, done: false }); scrollDown();
}
function finishTool(event) {
  const item = [...toolCards].reverse().find(card => card.name === event.name && !card.done);
  if (item) {
    item.done = true;
    item.state.textContent = event.result.error ? '오류' : event.result.denied ? '건너뜀' : '완료';
    if (event.result.error) item.card.classList.add('failed');
    item.output.textContent = JSON.stringify(event.result, null, 2);
  }
  if (['write_file', 'create_document'].includes(event.name) && event.result.saved) refreshFiles().catch(() => {});
  if (event.name === 'create_document' && event.result.saved) addDocumentDownload(event.result.path);
  scrollDown();
}
function addApproval(event, replay = false) {
  showConversation();
  const proposal = event.proposal;
  const card = element('section', 'approval-card');
  const title = element('div', 'approval-title');
  title.append(element('span', '', '◇'), element('span', '', proposal.name === 'create_document' ? '문서 저장 제안' : proposal.name === 'write_file' ? (proposal.before === null ? '새 파일 제안' : '파일 변경 제안') : proposal.name === 'run_command' ? '명령 실행 요청' : '탐색기 열기'));
  card.append(title);
  if (proposal.name === 'create_document') {
    card.append(element('div', 'approval-path', proposal.path), element('p', 'approval-note', `${proposal.title} · ${proposal.format.toUpperCase()} · 새 파일로 저장`));
    const preview = element('details'); preview.open = true;
    preview.append(element('summary', '', '저장할 문서 내용'), element('pre', '', proposal.content)); card.append(preview);
  } else if (proposal.name === 'write_file') {
    card.append(element('div', 'approval-path', proposal.path));
    if (proposal.before !== null) {
      const before = element('details'); before.append(element('summary', '', '현재 파일 보기'), element('pre', 'before-content', proposal.before)); card.append(before);
    }
    const after = element('details'); after.open = true;
    after.append(element('summary', '', '적용할 전체 내용'), element('pre', '', proposal.content)); card.append(after);
    card.append(element('p', 'approval-note', '적용 전 원본을 로컬 백업에 보관합니다.'));
  } else if (proposal.name === 'run_command') {
    card.append(element('div', 'approval-path', `실행 위치: ${proposal.cwd}`), element('pre', '', proposal.command), element('p', 'approval-note', 'PowerShell 명령은 일반 사용자 권한으로 실행됩니다. 작업 폴더 밖에도 영향을 줄 수 있으니 내용을 확인하세요.'));
  } else card.append(element('div', 'approval-path', proposal.path));
  const actions = element('div', 'approval-actions');
  const accept = element('button', 'primary', proposal.name === 'create_document' ? '문서 저장' : proposal.name === 'write_file' ? '변경 적용' : '실행');
  const deny = element('button', 'secondary', '건너뛰기');
  accept.type = deny.type = 'button';
  const resolved = element('span', 'approval-resolved');
  async function decide(approved) {
    accept.disabled = deny.disabled = true;
    try {
      await api('/api/decision', { id: event.id, approved });
      pendingId = null; resolved.textContent = approved ? '실행을 요청했습니다' : '건너뛰었습니다';
    } catch (error) { toast(error.message); accept.disabled = deny.disabled = false; }
  }
  accept.addEventListener('click', () => decide(true)); deny.addEventListener('click', () => decide(false));
  actions.append(accept, deny, resolved); card.append(actions);
  if (replay && event.id !== pendingId) { accept.hidden = deny.hidden = true; resolved.textContent = '검토가 종료된 작업입니다'; }
  $('#messages').append(card); scrollDown();
}
function setBusy(value) {
  busy = value;
  voiceChat?.setBusy(value);
  $('#send').hidden = value; $('#stop').hidden = !value; $('#activity').hidden = !value;
  $('#model').disabled = $('#mode').disabled = $('#new-chat').disabled = $('#workspace-button').disabled = value;
  $('#send').disabled = !connected || !$('#model').value;
  if (value) {
    startedAt = Date.now();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => { $('#elapsed').textContent = `${Math.floor((Date.now() - startedAt) / 1000)}초`; }, 1000);
  } else { clearInterval(elapsedTimer); $('#elapsed').textContent = ''; pendingId = null; }
}
function receive(event, replay = false) {
  if (event.type === 'user') addMessage('user', event.content);
  if (event.type === 'assistant') { addMessage('assistant', event.content, event.metrics); if (!replay) voiceChat?.maybeSpeak(event.content); }
  if (event.type === 'tool_start') addTool(event);
  if (event.type === 'tool_result') finishTool(event);
  if (event.type === 'activity' && !replay) $('#activity-text').textContent = event.message;
  if (event.type === 'approval') { if (!replay) { pendingId = event.id; $('#activity-text').textContent = '제안한 작업의 검토를 기다리고 있습니다'; } addApproval(event, replay); }
  if (event.type === 'error') addMessage('error', event.message);
  if (event.type === 'cancelled') addMessage('assistant', event.message);
  if (event.type === 'done' && !replay) setBusy(false);
}
async function sendPrompt(prompt) {
  if (busy || !prompt.trim()) return false;
  if (!connected) { toast('Ollama를 실행한 뒤 새로고침해 주세요.'); return false; }
  if (!$('#model').value) { toast('설치된 로컬 모델이 필요합니다.'); return false; }
  voiceChat?.beforeSend();
  setBusy(true); $('#activity-text').textContent = '답변을 준비하고 있습니다';
  addMessage('user', prompt.trim()); $('#prompt').value = ''; $('#prompt').style.height = '';
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-token': token }, body: JSON.stringify({ prompt: prompt.trim(), model: $('#model').value, mode: $('#mode').value }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffered = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      const lines = buffered.split('\n'); buffered = lines.pop();
      for (const line of lines) if (line.trim()) receive(JSON.parse(line));
    }
    buffered += decoder.decode(); if (buffered.trim()) receive(JSON.parse(buffered));
  } catch (error) { addMessage('error', error.message || '연결이 끊겼습니다.'); }
  finally { setBusy(false); $('#prompt').focus(); }
  return true;
}
async function refreshStatus() {
  const status = await api('/api/status');
  if (status.assistant) {
    assistant = status.assistant; $('#assistant-brand').textContent = assistant.name;
    $('#assistant-name').value = assistant.name; $('#assistant-wake').checked = assistant.requireWakeWord;
    document.title = `${assistant.name} · 내 PC의 AI 동료`;
  }
  connected = status.connected;
  $('#connection').textContent = '';
  $('#connection').append(element('i'), document.createTextNode(connected ? '로컬 모델 연결됨' : 'Ollama 연결 필요'));
  $('#connection').classList.toggle('offline', !connected);
  const selected = $('#model').value || status.model;
  $('#model').replaceChildren();
  if (!status.models.length) { const option = element('option', '', '설치된 모델 없음'); option.value = ''; $('#model').append(option); }
  for (const model of status.models) {
    const option = element('option', '', model.name.replace(':latest', '') + ` · ${(model.size / 1e9).toFixed(1)}GB`); option.value = model.name; $('#model').append(option);
  }
  if (status.models.some(model => model.name === selected)) $('#model').value = selected;
  $('#workspace-input').value = status.workspace;
  $('#workspace-name').textContent = status.workspace.split(/[\\/]/).filter(Boolean).pop();
  $('#workspace-short').textContent = status.workspace; $('#workspace-button').title = status.workspace;
  $('#hardware').textContent = `${status.hardware.ramGiB} GB RAM · ${status.hardware.logicalCores} THREADS`;
  $('#hardware').title = status.hardware.cpu;
  $('#send').disabled = busy || !connected || !$('#model').value;
}
async function refreshFiles() {
  const result = await api(`/api/files?path=${encodeURIComponent(currentDirectory)}`);
  $('#files-path').textContent = currentDirectory === '.' ? '/' : currentDirectory;
  $('#files-up').disabled = currentDirectory === '.';
  $('#file-list').replaceChildren();
  if (!result.entries.length) $('#file-list').append(element('p', 'empty-files', '폴더가 비어 있습니다.\nAI와 첫 파일을 만들어 보세요.'));
  for (const entry of result.entries) {
    const button = element('button', 'file-entry'); button.type = 'button';
    button.append(element('span', 'file-symbol', entry.type === 'directory' ? '▱' : entry.type === 'link' ? '↗' : '·'), element('span', 'file-name', entry.name));
    button.title = entry.path;
    button.addEventListener('click', async () => {
      try {
        if (entry.type === 'directory') { currentDirectory = entry.path; await refreshFiles(); }
        else { const file = await api(`${documentExtension.test(entry.path) ? '/api/documents/read' : '/api/file'}?path=${encodeURIComponent(entry.path)}`); previewPath = entry.path; $('#file-document-download').hidden = !documentExtension.test(entry.path); $('#file-title').textContent = entry.path; $('#file-content').textContent = file.content + (file.truncated ? '\n\n[미리보기 일부 생략]' : ''); $('#file-dialog').showModal(); }
      } catch (error) { toast(error.message); }
    });
    $('#file-list').append(button);
  }
}
function resetView() { transcript.length = toolCards.length = 0; $('#messages').replaceChildren(); $('#welcome').hidden = false; currentDirectory = '.'; }
async function newChat() {
  if (busy) return;
  voiceChat?.stopAll();
  try { await api('/api/reset', {}); resetView(); $('#prompt').focus(); }
  catch (error) { toast(error.message); }
}
async function downloadDocument(relative) {
  const response = await fetch(`/api/documents/download?path=${encodeURIComponent(relative)}`, { headers: { 'x-app-token': token } });
  if (!response.ok) { const error = await response.json(); throw new Error(error.error); }
  const url = URL.createObjectURL(await response.blob());
  const link = element('a'); link.href = url; link.download = relative.split(/[\\/]/).pop(); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function addDocumentDownload(relative) {
  const box = element('div', 'document-result');
  box.append(element('span', '', relative));
  const download = element('button', 'secondary', '문서 내려받기'); download.type = 'button';
  download.addEventListener('click', () => downloadDocument(relative).catch(error => toast(error.message)));
  box.append(download); $('#messages').append(box); scrollDown();
}
function documentInput() {
  const format = $('#document-format').value;
  const title = $('#document-title').value.trim() || '새 문서';
  const filename = ($('#document-filename').value.trim() || title.replace(/[\\/:*?"<>|]/g, '-')).replace(/\.(docx|xlsx|pptx|hwpx|hwp)$/i, '');
  return { path: `${filename}.${format}`, title, content: $('#document-content').value.trim() };
}
$('#documents-toggle').addEventListener('click', async () => {
  $('#documents-error').textContent = ''; $('#documents-dialog').showModal();
  try { const state = await api('/api/documents/status'); $('#documents-status').textContent = state.installed ? 'Word · Excel · PowerPoint · 한글 HWPX/HWP — 이 PC에서 생성합니다.' : 'setup-documents.cmd로 문서 기능을 설치해 주세요.'; $('#document-ai').disabled = $('#document-save').disabled = !state.installed; }
  catch (error) { $('#documents-status').textContent = error.message; }
});
$('#documents-close').addEventListener('click', () => $('#documents-dialog').close());
$('#document-ai').addEventListener('click', () => {
  if (busy) return;
  const input = documentInput(); const instruction = $('#document-request').value.trim();
  if (!instruction) { $('#documents-error').textContent = 'AI에게 요청할 내용을 입력해 주세요.'; return; }
  $('#mode').value = 'agent'; $('#documents-dialog').close();
  void sendPrompt(`${assistant.name}, ${instruction}\n문서 제목: ${input.title}\n저장할 파일: ${input.path}\n실제 문서 파일로 만들어 줘. 내용을 완성해서 저장 전에 보여 줘.`);
});
$('#documents-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const input = documentInput();
  if (!input.content) { $('#documents-error').textContent = '저장할 문서 본문을 입력해 주세요.'; return; }
  setBusy(true); $('#document-save').disabled = true; $('#documents-error').textContent = ''; $('#documents-status').textContent = '문서를 만들고 있습니다…';
  try { const result = await api('/api/documents/create', input); $('#documents-dialog').close(); addMessage('assistant', `${result.path} 문서를 저장했습니다.`); addDocumentDownload(result.path); await refreshFiles(); }
  catch (error) { $('#documents-error').textContent = error.message; }
  finally { setBusy(false); $('#document-save').disabled = false; $('#documents-status').textContent = '이 PC에서 문서를 생성합니다.'; }
});
$('#assistant-settings-toggle').addEventListener('click', () => { voiceChat?.stopAll(); $('#assistant-error').textContent = ''; $('#assistant-settings-dialog').showModal(); });
$('#assistant-settings-close').addEventListener('click', () => $('#assistant-settings-dialog').close());
$('#assistant-settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { assistant = await api('/api/assistant', { name: $('#assistant-name').value.trim(), requireWakeWord: $('#assistant-wake').checked }); await refreshStatus(); await voiceChat.refresh(); $('#assistant-settings-dialog').close(); toast('이름과 호출 규칙을 이 PC에 저장했습니다.'); }
  catch (error) { $('#assistant-error').textContent = error.message; }
});
voiceChat = createVoiceChat({ token, notify: toast,
  onTranscript(text) {
    const combined = [$('#prompt').value.trim(), text].filter(Boolean).join('\n');
    if (combined.length > 12000) throw new Error('기존 입력과 음성을 합치면 12,000자를 넘습니다. 입력을 줄여 주세요.');
    $('#prompt').value = combined; $('#prompt').dispatchEvent(new Event('input'));
  },
  onSend: () => sendPrompt($('#prompt').value),
});
$('#chat-form').addEventListener('submit', event => { event.preventDefault(); sendPrompt($('#prompt').value); });
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendPrompt(event.currentTarget.value); } });
$('#prompt').addEventListener('input', event => { event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`; });
$('#stop').addEventListener('click', async () => { voiceChat?.stopAll(); try { await api('/api/cancel', {}); } catch (error) { toast(error.message); } });
$('#new-chat').addEventListener('click', newChat);
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newChat(); } });
for (const button of document.querySelectorAll('.suggestion')) button.addEventListener('click', () => { $('#prompt').value = button.dataset.prompt; $('#prompt').focus(); });
$('#refresh-files').addEventListener('click', async () => { try { await Promise.all([refreshStatus(), refreshFiles()]); } catch (error) { toast(error.message); } });
$('#files-up').addEventListener('click', async () => { const parts = currentDirectory.replaceAll('\\', '/').split('/').filter(Boolean); parts.pop(); currentDirectory = parts.join('/') || '.'; try { await refreshFiles(); } catch (error) { toast(error.message); } });
$('#workspace-button').addEventListener('click', () => { $('#workspace-error').textContent = ''; $('#workspace-dialog').showModal(); $('#workspace-input').focus(); });
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => $('#workspace-dialog').close());
$('#close-file').addEventListener('click', () => $('#file-dialog').close());
$('#file-document-download').addEventListener('click', () => { if (previewPath) downloadDocument(previewPath).catch(error => toast(error.message)); });
$('#workspace-form').addEventListener('submit', async event => {
  event.preventDefault();
  voiceChat?.stopAll();
  try { await api('/api/workspace', { path: $('#workspace-input').value }); resetView(); await Promise.all([refreshStatus(), refreshFiles()]); $('#workspace-dialog').close(); toast('새 작업 폴더를 연결했습니다.'); }
  catch (error) { $('#workspace-error').textContent = error.message; }
});
$('#export-chat').addEventListener('click', () => {
  if (!transcript.length) return toast('아직 내보낼 대화가 없습니다.');
  const text = transcript.map(item => `${item.role === 'user' ? '나' : 'LOCAL MATE'}\n${item.content}\n`).join('\n---\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = element('a'); link.href = url; link.download = `local-mate-${new Date().toISOString().slice(0, 10)}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
(async () => {
  try {
    await refreshStatus(); await refreshFiles();
    const state = await api('/api/state'); pendingId = state.pending?.id || null;
    for (const event of state.timeline) receive(event, true);
    if (state.busy) { setBusy(true); pendingId = state.pending?.id || null; $('#activity-text').textContent = state.pending ? '제안한 작업의 검토를 기다리고 있습니다' : '진행 중인 작업에 다시 연결하고 있습니다'; pollState(state.timeline.at(-1)?.sequence || 0); }
    $('#prompt').focus();
  } catch (error) { toast(error.message); }
})();
async function pollState(seen) {
  const timer = setInterval(async () => {
    try {
      const state = await api('/api/state');
      for (const event of state.timeline.filter(item => item.sequence > seen)) receive(event);
      seen = state.timeline.at(-1)?.sequence || seen;
      if (!state.busy) { clearInterval(timer); setBusy(false); }
    } catch { clearInterval(timer); setBusy(false); }
  }, 1000);
}
