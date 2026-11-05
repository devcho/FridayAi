// Keep this entry compatible with the routes of an older running server.
try {
  const token = document.querySelector('meta[name="app-token"]').content;
  const response = await fetch('/api/status', { headers: { 'x-app-token': token }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('사이트를 새로고침해 주세요.');
  const state = await response.json();
  if (!state.assistant && location.port === '3210') {
    const updated = new URL(location.href); updated.port = '3211'; updated.pathname = '/'; updated.search = ''; updated.hash = '';
    location.replace(updated.href);
  } else {
    await import('./workspace-app.js');
  }
} catch (error) {
  const notice = document.querySelector('#toast'); notice.textContent = `서비스 연결을 확인해 주세요. ${error.message}`; notice.hidden = false;
}
