// Open-Meteo public, non-commercial API. Never send conversation or local files.
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
// GeoNames sometimes indexes major Korean cities under romanized names only.
const CITY_NAMES = { '수원': 'Suwon', '수원시': 'Suwon', '서울': 'Seoul', '서울시': 'Seoul', '부산': 'Busan', '부산시': 'Busan', '인천': 'Incheon', '대구': 'Daegu', '대전': 'Daejeon', '광주': 'Gwangju', '울산': 'Ulsan', '화성': 'Hwaseong', '화성시': 'Hwaseong' };

async function request(url, signal, fetchImpl) {
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`날씨 서비스 오류 (HTTP ${response.status}). 잠시 후 다시 시도해 주세요.`);
  const data = await response.json();
  if (data.error) throw new Error('날씨 서비스가 요청을 처리하지 못했습니다.');
  return data;
}

export async function getWeather(args, { signal, fetchImpl = fetch } = {}) {
  if (!args || typeof args.location !== 'string' || !args.location.trim() || args.location.length > 100) {
    throw new Error('날씨를 확인할 지역명을 입력해 주세요. 예: 수원, 서울, Tokyo');
  }
  const day = args.day ?? 'today';
  if (!['today', 'tomorrow'].includes(day)) throw new Error('오늘 또는 내일 예보를 선택해 주세요.');
  const location = args.location.trim();
  const geoUrl = new URL(GEO);
  const [city, ...qualifiers] = location.split(',').map(part => part.trim());
  const searchName = [CITY_NAMES[city] || city, ...qualifiers].join(', ');
  geoUrl.search = new URLSearchParams({ name: searchName, language: 'ko', count: '5', format: 'json', ...(CITY_NAMES[city] ? { countryCode: 'KR' } : {}) });
  let geo, data;
  try { geo = await request(geoUrl, signal, fetchImpl); }
  catch (error) { if (signal?.aborted) throw signal.reason; throw new Error(`지역 조회 실패: ${error.message}`); }
  let matches = (geo.results || []).filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude) && (!item.feature_code || item.feature_code.startsWith('PPL')));
  const canonical = { '수원': '수원시', '수원시': '수원시', '화성': '화성시', '화성시': '화성시' }[city];
  if (canonical) {
    const cityMatches = matches.filter(item => item.name === canonical && item.admin1 === '경기도');
    if (cityMatches.length) matches = cityMatches;
  }
  if (!matches.length) return { found: false, message: `“${location}” 지역을 찾지 못했습니다. 가까운 도시나 시·군 이름으로 다시 알려주세요.` };
  // Do not silently choose among duplicate city names.
  if (matches.length > 1) return { found: false, needsClarification: true, message: '동명이 있는 지역입니다. 국가나 도 이름을 함께 알려주세요.', candidates: matches.map(item => ({ name: item.name, region: item.admin1, country: item.country })) };
  const place = matches[0];
  const url = new URL(FORECAST);
  url.search = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'auto', forecast_days: '2', temperature_unit: 'celsius', wind_speed_unit: 'ms',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' });
  try { data = await request(url, signal, fetchImpl); }
  catch (error) { if (signal?.aborted) throw signal.reason; throw new Error(`날씨 조회 실패: ${error.message}`); }
  const index = day === 'tomorrow' ? 1 : 0;
  const daily = data.daily;
  if (!daily?.time?.[index] || !Number.isFinite(daily.temperature_2m_max?.[index]) || !Number.isFinite(daily.temperature_2m_min?.[index])) {
    throw new Error('날씨 서비스에서 유효한 예보를 받지 못했습니다. 기온을 추측하지 말고 다시 시도해 주세요.');
  }
  return { found: true, source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/', dataType: '모델 기반 날씨 및 예보', fetchedAt: new Date().toISOString(),
    location: { name: place.name, region: place.admin1, country: place.country }, timezone: data.timezone,
    current: day === 'today' && Number.isFinite(data.current?.temperature_2m) ? { time: data.current.time, temperatureC: data.current.temperature_2m,
      feelsLikeC: data.current.apparent_temperature, humidityPercent: data.current.relative_humidity_2m,
      condition: weatherDescription(data.current.weather_code), windMetresPerSecond: data.current.wind_speed_10m } : null,
    forecast: { date: daily.time[index], condition: weatherDescription(daily.weather_code?.[index]), maxC: daily.temperature_2m_max[index],
      minC: daily.temperature_2m_min[index], precipitationProbabilityPercent: daily.precipitation_probability_max?.[index] ?? null } };
}

function weatherDescription(code) {
  if (code === 0) return '맑음';
  if ([1, 2].includes(code)) return '구름 조금';
  if (code === 3) return '흐림';
  if ([45, 48].includes(code)) return '안개';
  if ([51, 53, 55, 56, 57].includes(code)) return '이슬비';
  if ([61, 63, 65, 66, 67].includes(code)) return '비';
  if ([71, 73, 75, 77].includes(code)) return '눈';
  if ([80, 81, 82].includes(code)) return '소나기';
  if ([85, 86].includes(code)) return '눈 소나기';
  if ([95, 96, 99].includes(code)) return '뇌우';
  return '상태 정보 없음';
}
