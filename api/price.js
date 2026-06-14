/**
 * Vercel Serverless Function — /api/price
 *
 * GET /api/price?tickers=005930.KS,035420.KQ,SPY,^GSPC
 *
 * 한국 개별주식(.KS/.KQ) → KIS API
 * 해외주식 / 지수(^KS11, ^GSPC 등) → Yahoo Finance
 *
 * 환경변수 (Vercel Dashboard > Settings > Environment Variables):
 *   KIS_APP_KEY    — KIS 개발자센터 앱 키
 *   KIS_APP_SECRET — KIS 개발자센터 앱 시크릿
 *   KIS_MODE       — "real" (실계좌, 기본값) | "paper" (모의투자)
 */

const KIS_REAL  = 'https://openapi.koreainvestment.com:9443';
const KIS_PAPER = 'https://openapivts.koreainvestment.com:29443';

// 컨테이너 내 메모리 캐시 (warm 재사용 시 1차 히트)
let _memToken = null;
let _memTokenExp = 0;

function kisBase() {
  return process.env.KIS_MODE === 'paper' ? KIS_PAPER : KIS_REAL;
}

// ── Vercel KV REST API 헬퍼 ───────────────────────────────────────
// KV가 연결되어 있으면 컨테이너 간 토큰 공유 가능 (cold start 시에도 재사용)
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_KEY   = 'kis_access_token';

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    const j = await r.json();
    return j.result || null;
  } catch { return null; }
}

async function kvSet(token, ttlSeconds) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    await fetch(`${KV_URL}/set/${KV_KEY}/${encodeURIComponent(token)}/ex/${ttlSeconds}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

// ── KIS 토큰 발급 / 캐시 ──────────────────────────────────────────
// 우선순위: 1) 메모리 캐시  2) Vercel KV  3) 신규 발급
async function getToken() {
  // 1) 메모리 캐시 확인
  if (_memToken && Date.now() < _memTokenExp) return _memToken;

  // 2) Vercel KV 확인 (cold start 후에도 토큰 재사용)
  const cached = await kvGet();
  if (cached) {
    console.log('KIS 토큰 KV 캐시 사용');
    _memToken    = cached;
    _memTokenExp = Date.now() + 60 * 60 * 1000; // 메모리엔 1시간만
    return cached;
  }

  // 3) 신규 발급 (SMS 발송됨 — 하루 1회 이하)
  const res = await fetch(`${kisBase()}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey:     process.env.KIS_APP_KEY,
      appsecret:  process.env.KIS_APP_SECRET,
    }),
  });

  if (!res.ok) throw new Error(`KIS token HTTP ${res.status}`);
  const d = await res.json();
  if (!d.access_token) throw new Error('KIS token 발급 실패: ' + JSON.stringify(d));

  const token   = d.access_token;
  const ttl     = 23 * 60 * 60; // 23시간(초)
  _memToken     = token;
  _memTokenExp  = Date.now() + ttl * 1000;

  // KV에 저장 (비동기, 실패해도 무관)
  kvSet(token, ttl);

  console.log('KIS 신규 토큰 발급 완료 (KV 저장)');
  return token;
}

// ── KIS 국내 주식 현재가 ──────────────────────────────────────────
async function fetchKis(ticker) {
  const code  = ticker.replace(/\.(KS|KQ|KP)$/i, ''); // "005930.KS" → "005930"
  const token = await getToken();

  const url = `${kisBase()}/uapi/domestic-stock/v1/quotations/inquire-price?` +
    new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });

  const res = await fetch(url, {
    headers: {
      'Content-Type':  'application/json',
      'authorization': `Bearer ${token}`,
      'appkey':        process.env.KIS_APP_KEY,
      'appsecret':     process.env.KIS_APP_SECRET,
      'tr_id':         'FHKST01010100',
      'custtype':      'P',
    },
  });

  if (!res.ok) return null;
  const d = await res.json();
  if (d.rt_cd !== '0') {
    console.warn(`KIS ${ticker} 오류:`, d.msg1);
    return null;
  }

  const o = d.output;
  return {
    price:     parseFloat(o.stck_prpr),   // 현재가
    dayChg:    parseFloat(o.prdy_vrss),   // 전일 대비
    dayPct:    parseFloat(o.prdy_ctrt),   // 전일 대비율(%)
    currency:  'KRW',
    source:    'KIS',
    fetchedAt: new Date().toISOString(),
  };
}

// ── Yahoo Finance (해외 + 지수) ───────────────────────────────────
async function fetchYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioBot/1.0)' },
    signal:  AbortSignal.timeout(8000),
  });

  if (!res.ok) return null;
  const d = await res.json();
  const meta = d?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;

  const p    = meta.regularMarketPrice;
  const prev = meta.previousClose || p;

  return {
    price:     p,
    dayChg:    p - prev,
    dayPct:    ((p - prev) / prev) * 100,
    currency:  meta.currency,
    source:    'Yahoo',
    fetchedAt: new Date().toISOString(),
  };
}

// ── 한국 개별 주식/ETF 여부 판별 ─────────────────────────────────
// .KS/.KQ/.KP 접미사 또는 KRX 코드 형식(숫자로 시작하는 6자리 알파뉴메릭)
// 예: 005930, 069500, 0177N0, 0183J0
// 지수(^KS11)는 Yahoo 사용 — KIS 지수 API는 별도 tr_id 필요
function isKoreanStock(ticker) {
  return /\.(KS|KQ|KP)$/i.test(ticker) || /^\d[A-Z0-9]{5}$/i.test(ticker);
}

// ── Yahoo Finance 한국 티커 변환 ──────────────────────────────────
// KRX 코드(숫자로 시작하는 6자리)에 .KS 붙여야 Yahoo에서 조회 가능
function toYahooTicker(ticker) {
  if (/^\d[A-Z0-9]{5}$/i.test(ticker)) return ticker + '.KS';
  return ticker;
}


// ── 메인 핸들러 ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const tickers = (req.query.tickers || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (!tickers.length) {
    return res.status(400).json({ error: 'tickers 파라미터가 필요합니다. 예: ?tickers=005930.KS,SPY' });
  }

  const hasKis = !!(process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET);

  const prices = {};
  await Promise.all(tickers.map(async (ticker) => {
    try {
      let data = null;
      const isKorean = isKoreanStock(ticker);

      if (isKorean) {
        // 국내 주식/ETF → KIS 우선, KIS 실패 시 Yahoo(+.KS) 폴백
        if (hasKis) {
          data = await fetchKis(ticker).catch(e => {
            console.warn(`KIS ${ticker} 실패 (${e.message}), Yahoo로 폴백`);
            return null;
          });
          if (data) console.log(`KIS OK: ${ticker} → ${data.price}`);
        }
        if (!data) {
          // KIS 미설정 또는 KIS 실패 → Yahoo에 .KS 붙여서 시도
          const yahooTicker = toYahooTicker(ticker);
          data = await fetchYahoo(yahooTicker);
          if (data) {
            data.source = 'Yahoo(KR)';
            console.log(`Yahoo(KR) OK: ${ticker}(→${yahooTicker}) → ${data.price}`);
          } else {
            console.warn(`❌ ${ticker}: KIS + Yahoo 모두 실패`);
          }
        }
      } else {
        // 해외 주식/ETF / 지수 → Yahoo Finance
        data = await fetchYahoo(ticker);
        if (data) console.log(`Yahoo OK: ${ticker} → ${data.price}`);
        else console.warn(`❌ ${ticker}: Yahoo 조회 실패`);
      }

      if (data) prices[ticker] = data;

    } catch (e) {
      console.error(`${ticker} 오류:`, e.message);
    }
  }));

  // 5분 CDN 캐시 (Vercel Edge)
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');

  return res.json({
    updatedAt: new Date().toISOString(),
    prices,
    meta: {
      total:     tickers.length,
      success:   Object.keys(prices).length,
      kisEnabled: hasKis,
    },
  });
}
