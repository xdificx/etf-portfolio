/**
 * Vercel Serverless Function — /api/price
 *
 * GET /api/price?tickers=005930.KS,035420.KQ,SPY,^GSPC
 * GET /api/price?type=exchangerate
 *
 * 지수(^ 로 시작) → Yahoo Finance
 * 국내/해외 주식·ETF → Toss Open API (Toss 미설정 시 Yahoo 폴백)
 *
 * 환경변수 (Vercel Dashboard > Settings > Environment Variables):
 *   TOSS_CLIENT_ID     — 토스증권 Open API client_id
 *   TOSS_CLIENT_SECRET — 토스증권 Open API client_secret
 */

const TOSS_BASE = 'https://openapi.tossinvest.com';

// ── 메모리 캐시 ────────────────────────────────────────────────────
let _tossToken    = null;
let _tossTokenExp = 0;

// ── Vercel KV REST API (cold start 간 토큰 공유) ──────────────────
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_KEY   = 'toss_access_token';

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

// ── Toss OAuth2 토큰 발급 / 캐시 ─────────────────────────────────
// 우선순위: 1) 메모리  2) Vercel KV  3) 신규 발급
async function getTossToken() {
  if (_tossToken && Date.now() < _tossTokenExp) return _tossToken;

  const cached = await kvGet();
  if (cached) {
    _tossToken    = cached;
    _tossTokenExp = Date.now() + 50 * 60 * 1000;
    console.log('Toss 토큰 KV 캐시 사용');
    return cached;
  }

  const clientId     = process.env.TOSS_CLIENT_ID;
  const clientSecret = process.env.TOSS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('TOSS_CLIENT_ID/SECRET 미설정');

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${TOSS_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body:   'grant_type=client_credentials',
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) throw new Error(`Toss token HTTP ${res.status}`);
  const d = await res.json();
  if (!d.access_token) throw new Error('Toss token 발급 실패: ' + JSON.stringify(d));

  const ttl        = 55 * 60; // 55분(초)
  _tossToken       = d.access_token;
  _tossTokenExp    = Date.now() + ttl * 1000;
  kvSet(_tossToken, ttl);
  console.log('Toss 신규 토큰 발급 완료');
  return _tossToken;
}

// ── Toss 현재가 조회 (최대 200개 한 번에) ─────────────────────────
async function fetchTossPrices(tossSymbols) {
  const token = await getTossToken();
  const res   = await fetch(
    `${TOSS_BASE}/api/v1/prices?symbols=${encodeURIComponent(tossSymbols.join(','))}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) throw new Error(`Toss prices HTTP ${res.status}`);
  const d = await res.json();
  return d.result || [];
}

// ── Toss 환율 조회 (USD→KRW 매매기준율) ──────────────────────────
async function fetchTossExchangeRate() {
  const token = await getTossToken();
  const res   = await fetch(
    `${TOSS_BASE}/api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) return null;
  const d = await res.json();
  return parseFloat(d.result?.midRate) || null;
}

// ── Yahoo Finance (지수 및 Toss 폴백) ────────────────────────────
async function fetchYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioBot/1.0)' },
    signal:  AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const d    = await res.json();
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

// ── 헬퍼 ─────────────────────────────────────────────────────────

// 지수 여부 (^KS11, ^GSPC 등)
function isIndex(ticker) {
  return ticker.startsWith('^');
}

// 앱 ticker → Toss 심볼 변환
// "005930.KS" → "005930", "035420.KQ" → "035420", "QQQ" → "QQQ"
function toTossSymbol(ticker) {
  return ticker.replace(/\.(KS|KQ|KP)$/i, '');
}

// Yahoo용 ticker 변환 (KRX 6자리에 .KS 붙이기)
function toYahooTicker(ticker) {
  if (/^\d[A-Z0-9]{5}$/i.test(ticker)) return ticker + '.KS';
  return ticker;
}

// ── 메인 핸들러 ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const hasToss = !!(process.env.TOSS_CLIENT_ID && process.env.TOSS_CLIENT_SECRET);

  // ── 환율 조회 모드 ────────────────────────────────────────────
  if (req.query.type === 'exchangerate') {
    if (hasToss) {
      try {
        const rate = await fetchTossExchangeRate();
        if (rate) {
          return res.json({ rate, source: 'Toss', updatedAt: new Date().toISOString() });
        }
      } catch (e) { console.warn('Toss 환율 실패:', e.message); }
    }
    // 폴백: exchangerate-api
    try {
      const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      if (d.rates?.KRW) return res.json({ rate: d.rates.KRW, source: 'exchangerate-api', updatedAt: new Date().toISOString() });
    } catch {}
    return res.status(502).json({ error: '환율 조회 실패' });
  }

  // ── 가격 조회 모드 ────────────────────────────────────────────
  const tickers = (req.query.tickers || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!tickers.length) return res.status(400).json({ error: 'tickers 파라미터 필요. 예: ?tickers=005930.KS,SPY' });

  const prices = {};
  const now    = new Date().toISOString();

  // 지수(^...) → Yahoo, 나머지 → Toss
  const indexTickers = tickers.filter(isIndex);
  const stockTickers = tickers.filter(t => !isIndex(t));

  // 지수: Yahoo 병렬 조회
  await Promise.all(indexTickers.map(async ticker => {
    try {
      const data = await fetchYahoo(ticker);
      if (data) {
        prices[ticker] = { ...data, fetchedAt: now };
        console.log(`Yahoo(index) OK: ${ticker} → ${data.price}`);
      } else {
        console.warn(`❌ Yahoo(index) 실패: ${ticker}`);
      }
    } catch (e) { console.error(`${ticker}:`, e.message); }
  }));

  // 주식/ETF → Toss 한 번에 조회 (최대 200개)
  if (stockTickers.length > 0) {
    if (hasToss) {
      try {
        const tossSymbols  = stockTickers.map(toTossSymbol);
        const tossResults  = await fetchTossPrices(tossSymbols);

        // tossSymbol → 결과 맵
        const resultBySymbol = {};
        for (const r of tossResults) resultBySymbol[r.symbol] = r;

        for (const ticker of stockTickers) {
          const sym = toTossSymbol(ticker);
          const r   = resultBySymbol[sym];
          if (r && r.lastPrice != null) {
            prices[ticker] = {
              price:     parseFloat(r.lastPrice),
              dayChg:    0,   // Toss API는 전일대비 미제공
              dayPct:    0,
              currency:  r.currency || (sym.length === 6 && /^\d/.test(sym) ? 'KRW' : 'USD'),
              source:    'Toss',
              fetchedAt: now,
            };
            console.log(`Toss OK: ${ticker}(${sym}) → ${r.lastPrice}`);
          } else {
            console.warn(`Toss 결과 없음: ${ticker}(${sym})`);
          }
        }

        // Toss에서 실패한 종목 → Yahoo 폴백
        const failed = stockTickers.filter(t => !prices[t]);
        if (failed.length > 0) {
          console.log(`Yahoo 폴백 대상 ${failed.length}개:`, failed.join(','));
          await Promise.all(failed.map(async ticker => {
            try {
              const data = await fetchYahoo(toYahooTicker(ticker));
              if (data) {
                prices[ticker] = { ...data, source: 'Yahoo(fallback)', fetchedAt: now };
                console.log(`Yahoo(fallback) OK: ${ticker}`);
              } else {
                console.warn(`❌ ${ticker}: Toss + Yahoo 모두 실패`);
              }
            } catch {}
          }));
        }

      } catch (e) {
        // Toss 전체 실패 → 전부 Yahoo
        console.warn('Toss 가격 조회 전체 실패, Yahoo 폴백:', e.message);
        await Promise.all(stockTickers.map(async ticker => {
          try {
            const data = await fetchYahoo(toYahooTicker(ticker));
            if (data) prices[ticker] = { ...data, source: 'Yahoo(fallback)', fetchedAt: now };
          } catch {}
        }));
      }
    } else {
      // Toss 미설정 → 전부 Yahoo
      await Promise.all(stockTickers.map(async ticker => {
        try {
          const data = await fetchYahoo(toYahooTicker(ticker));
          if (data) prices[ticker] = { ...data, fetchedAt: now };
        } catch {}
      }));
    }
  }

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  return res.json({
    updatedAt: now,
    prices,
    meta: {
      total:       tickers.length,
      success:     Object.keys(prices).length,
      tossEnabled: hasToss,
    },
  });
}
