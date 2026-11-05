import test from 'node:test';
import assert from 'node:assert/strict';
import { getWeather } from '../lib/weather.mjs';
import { ACTION_SCHEMA, buildSystemPrompt, runAgent } from '../lib/agent.mjs';

const place = { name: '수원', admin1: '경기도', country: '대한민국', latitude: 37.29, longitude: 127.01 };
const forecast = { timezone: 'Asia/Seoul', current: { time: '2026-11-05T11:00', temperature_2m: 14, weather_code: 0 },
  daily: { time: ['2026-11-05', '2026-11-06'], temperature_2m_max: [17, 18], temperature_2m_min: [5, 6], weather_code: [0, 61], precipitation_probability_max: [0, 80] } };
const ok = data => ({ ok: true, json: async () => data });
function mockWeather() {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return ok(calls.length === 1 ? { results: [place] } : forecast);
  } };
}

test('queries fixed providers and preserves Celsius, date, source and zero rain probability', async () => {
  const mock = mockWeather();
  const result = await getWeather({ location: '수원' }, mock);
  assert.equal(result.current.temperatureC, 14);
  assert.equal(result.forecast.precipitationProbabilityPercent, 0);
  assert.equal(result.forecast.date, '2026-11-05');
  assert.equal(result.source, 'Open-Meteo');
  assert.equal(mock.calls[0].url.hostname, 'geocoding-api.open-meteo.com');
  assert.equal(mock.calls[0].url.searchParams.get('name'), 'Suwon');
  assert.equal(mock.calls[0].url.searchParams.get('countryCode'), 'KR');
  assert.equal(mock.calls[1].url.hostname, 'api.open-meteo.com');
  assert.equal(mock.calls[1].url.searchParams.get('timezone'), 'auto');
  assert.equal(mock.calls[1].url.searchParams.get('temperature_unit'), 'celsius');
  assert.equal(mock.calls[1].options.redirect, 'error');
});

test('tomorrow returns next day forecast without presenting current data as tomorrow', async () => {
  const result = await getWeather({ location: '수원', day: 'tomorrow' }, mockWeather());
  assert.equal(result.current, null);
  assert.equal(result.forecast.date, '2026-11-06');
  assert.equal(result.forecast.condition, '비');
});

test('Korean Suwon resolves the Gyeonggi city rather than similarly named villages', async () => {
  let calls = 0;
  const result = await getWeather({ location: '수원' }, { fetchImpl: async () => ok(++calls === 1 ? { results: [
    { ...place, name: '수원시', feature_code: 'PPLA2' },
    { ...place, admin1: '충청남도', feature_code: 'PPL' },
    { ...place, name: '수원산', feature_code: 'MT' },
  ] } : forecast) });
  assert.equal(result.found, true);
  assert.equal(result.location.name, '수원시');
  assert.equal(result.location.region, '경기도');
});

test('missing or ambiguous places never silently fall back to another city', async () => {
  for (const results of [[], [place, { ...place, country: '다른 나라' }]]) {
    let calls = 0;
    const result = await getWeather({ location: '수원' }, { fetchImpl: async () => { calls++; return ok({ results }); } });
    assert.equal(result.found, false);
    assert.equal(calls, 1);
  }
});

test('invalid arguments, HTTP failures and malformed forecasts fail without invented data', async () => {
  await assert.rejects(getWeather({ location: '' }), /지역명/);
  await assert.rejects(getWeather({ location: '수원', day: 'yesterday' }), /오늘 또는 내일/);
  await assert.rejects(getWeather({ location: '수원' }, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
  let count = 0;
  await assert.rejects(getWeather({ location: '수원' }, { fetchImpl: async () => ok(++count === 1 ? { results: [place] } : {}) }), /유효한 예보/);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(getWeather({ location: '수원' }, { signal: controller.signal, fetchImpl: async () => { throw controller.signal.reason; } }), /cancelled/);
});

test('weather tool runs in chat mode and returns results to model before its answer', async () => {
  assert.ok(ACTION_SCHEMA.properties.actions.items.anyOf.some(item => item.properties.name.enum.includes('get_weather')));
  assert.match(buildSystemPrompt('.', 'chat'), /Only get_weather actions are allowed/);
  const originalFetch = globalThis.fetch;
  const mock = mockWeather(); globalThis.fetch = mock.fetchImpl;
  const events = [];
  const session = { history: [], workspace: '.', mode: 'chat', model: 'test' };
  let turns = 0;
  try {
    await runAgent({ session, prompt: '수원 날씨 알려줘', signal: new AbortController().signal, emit: event => events.push(event),
      approve: () => { throw new Error('read-only weather must not request approval'); },
      modelCall: async ({ history }) => {
        if (++turns === 1) return { message: '', actions: [{ name: 'get_weather', arguments: { location: '수원' } }] };
        assert.match(history.at(-1).content, /Open-Meteo/);
        return { message: '수원 현재 기온은 14도입니다. 출처 Open-Meteo.', actions: [] };
      } });
    assert.equal(events.find(event => event.type === 'tool_result').result.current.temperatureC, 14);
    assert.ok(events.some(event => event.type === 'assistant'));
  } finally { globalThis.fetch = originalFetch; }
});
