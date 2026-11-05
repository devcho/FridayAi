const ports = process.env.PORT ? [Number(process.env.PORT)] : [3210, 3211];
let stopped = false;
for (const port of ports) {
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(2000) });
    const html = await response.text();
    const token = html.match(/name="app-token" content="([^"]+)"/)?.[1];
    if (!token || !html.includes('내 PC의 AI 동료')) continue;
    const statusResponse = await fetch(`${base}/api/status`, { headers: { 'x-app-token': token }, signal: AbortSignal.timeout(5000) });
    const state = await statusResponse.json();
    if (!statusResponse.ok || !state.assistant) continue;
    const result = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-app-token': token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
    if (!result.ok) throw new Error('서비스를 중지하지 못했습니다.');
    stopped = true; console.log('프라이데이 서비스를 종료했습니다.'); break;
  } catch (error) {
    if (!['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(error.cause?.code)) { console.error(error.message); process.exitCode = 1; }
  }
}
if (!stopped && !process.exitCode) console.log('실행 중인 업데이트 서비스가 없습니다.');
