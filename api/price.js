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

// Lambda 컨테이너 내 토큰 캐시 (warm 재사용 시 유효)
let _token = null;
let _tokenExp = 0;

function kisBase() {
  return process.env.KIS_MODE === 'paper' ? KIS_PAPER : KIS_REAL;
}

// ── KIS 토큰 발급 / 캐시 ──────────────────────────────────────────
async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;

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

  _token    = d.access_token;
  _tokenExp = Date.now() + 23 * 60 * 60 * 1000; // 23시간 캐시 (토큰 유효기간 24h)
  console.log('KIS 토큰 발급 완료');
  return _token;
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
// 지수(^KS11, ^KQ11)는 Yahoo Finance 사용 — KIS 지수 API는 별도 tr_id 필요
function isKoreanStock(ticker) {
  return /\.(KS|KQ|KP)$/i.test(ticker) || /^\d{6}$/.test(ticker);
}

// ── Yahoo Finance 한국 티커 변환 ──────────────────────────────────
// 6자리 숫자만 있으면 .KS 붙여서 Yahoo에 전달
function toYahooTicker(ticker) {
  if (/^\d{6}$/.test(ticker)) return ticker + '.KS';
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

      if (hasKis && isKorean) {
        // 한국 주식/ETF → KIS API 우선
        data = await fetchKis(ticker).catch(e => {
          console.warn(`KIS ${ticker} 실패 (${e.message}), Yahoo로 폴백`);
          return null;
        });
        if (data) console.log(`KIS OK: ${ticker} → ${data.price}`);
      }

      // KIS 실패하거나 해외 종목이면 Yahoo Finance
      if (!data) {
        const yahooTicker = toYahooTicker(ticker);
        data = await fetchYahoo(yahooTicker);
        if (data) {
          data.source = isKorean ? 'Yahoo(KR)' : 'Yahoo';
          console.log(`Yahoo OK: ${ticker}(→${yahooTicker}) → ${data.price}`);
        } else {
          console.warn(`❌ ${ticker}: KIS + Yahoo 모두 실패 (Yahoo ticker: ${yahooTicker})`);
        }
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
