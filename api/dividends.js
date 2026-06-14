/**
 * Vercel Serverless Function — /api/dividends
 *
 * GET /api/dividends?tickers=SPY,069500.KS,0177N0
 * GET /api/dividends?tickers=069500.KS&debug=1
 *
 * 국내 ETF/주식 → KRX OpenAPI (한국거래소 공식 데이터)
 * 해외 ETF/주식 → Yahoo Finance
 */

// ── 티커 판별 ─────────────────────────────────────────────────────────────
function isKoreanTicker(ticker) {
  return /\.(KS|KQ|KP)$/i.test(ticker) || /^\d[A-Z0-9]{5}$/i.test(ticker);
}

function getKrCode(ticker) {
  return ticker.replace(/\.(KS|KQ|KP)$/i, '');
}

function toYahooTicker(ticker) {
  if (/^\d[A-Z0-9]{5}$/i.test(ticker)) return ticker + '.KS';
  return ticker;
}

// ── 공통: 지급 주기 감지 ─────────────────────────────────────────────────
function detectFrequency(history) {
  if (history.length < 2) return 'annual';
  const gaps = [];
  for (let i = 1; i < history.length; i++) {
    const d1 = new Date(history[i - 1].date);
    const d2 = new Date(history[i].date);
    gaps.push((d2 - d1) / (1000 * 60 * 60 * 24));
  }
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (avg < 45)  return 'monthly';
  if (avg < 120) return 'quarterly';
  if (avg < 270) return 'semi-annual';
  return 'annual';
}

function buildResult(ticker, history, currency) {
  if (!history || !history.length) return null;
  history.sort((a, b) => a.date.localeCompare(b.date));
  const recent    = history.slice(-Math.min(4, history.length));
  const avgAmount = recent.reduce((s, d) => s + d.amount, 0) / recent.length;
  const last      = history[history.length - 1];
  return {
    ticker,
    frequency:  detectFrequency(history),
    lastAmount: last.amount,
    avgAmount:  parseFloat(avgAmount.toFixed(6)),
    lastExDate: last.date,
    history:    history.slice(-24), // 최근 24회
    currency,
    fetchedAt:  new Date().toISOString(),
  };
}

// ── KRX 데이터포털 ────────────────────────────────────────────────────────
// https://data.krx.co.kr — 한국거래소 정보데이터시스템
// 2단계: OTP 발급 → 파일 다운로드
const KRX_OTP_URL  = 'https://data.krx.co.kr/comm/fileDn/GenerateOTP/generate.cmd';
const KRX_DOWN_URL = 'https://data.krx.co.kr/comm/fileDn/GenerateOTP/download.cmd';
const KRX_KEY      = process.env.KRX_API_KEY;

const KRX_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Referer':      'https://data.krx.co.kr/',
  'User-Agent':   'Mozilla/5.0 (compatible; PortfolioBot/1.0)',
};

async function krxGenerateOtp(params) {
  const body = new URLSearchParams({ auth: KRX_KEY, name: 'fileDown', ...params });
  const res = await fetch(KRX_OTP_URL, {
    method: 'POST',
    headers: KRX_HEADERS,
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`KRX OTP HTTP ${res.status}`);
  const otp = await res.text();
  if (!otp || otp.length < 10) throw new Error(`KRX OTP 응답 이상: ${otp}`);
  return otp.trim();
}

async function krxDownload(otp) {
  const res = await fetch(KRX_DOWN_URL, {
    method: 'POST',
    headers: KRX_HEADERS,
    body: `code=${encodeURIComponent(otp)}`,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KRX download HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// 날짜 형식 정규화: "20240308" → "2024-03-08", "2024.03.08" → "2024-03-08"
function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[.\-\/]/g, '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return null;
}

async function fetchKrxDividend(ticker, dbg) {
  if (!KRX_KEY) {
    dbg.push({ step: 'krx_skip', reason: 'KRX_API_KEY 환경변수 없음' });
    return null;
  }

  const code = getKrCode(ticker);
  // KRX 날짜 범위: 최근 3년
  const endDt   = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const startDt = new Date(Date.now() - 3*365*24*3600*1000).toISOString().slice(0,10).replace(/-/g,'');

  // ── 시도 1: ETF 분배금 지급 현황 (MDCSTAT04401) ─────────────────────────
  try {
    const otp = await krxGenerateOtp({
      bld:    'dbms/MDC/STAT/standard/MDCSTAT04401',
      isuCd:  code,
      strtDd: startDt,
      endDd:  endDt,
    });
    dbg.push({ step: 'krx_otp1', otp: otp.slice(0,20) + '...' });

    const data = await krxDownload(otp);
    dbg.push({ step: 'krx_data1', type: typeof data,
      sample: JSON.stringify(data).slice(0, 400) });

    const rows = Array.isArray(data) ? data
      : data?.output ?? data?.OutBlock_1 ?? data?.result ?? data?.list ?? [];

    if (Array.isArray(rows) && rows.length) {
      dbg.push({ step: 'krx_rows1', count: rows.length, first: rows[0] });
      const history = [];
      for (const row of rows) {
        // 컬럼명 후보: 분배기준일, 기준일, BAS_DD, 주당분배금, 분배금, DVD_AMT
        const rawDate = row['분배기준일'] ?? row['기준일'] ?? row['BAS_DD']
          ?? row['표준코드'] ?? Object.values(row).find(v => /^\d{8}$/.test(String(v)));
        const rawAmt  = row['주당분배금'] ?? row['분배금(원)'] ?? row['분배금']
          ?? row['DVD_AMT'] ?? row['1주당배당금']
          ?? Object.values(row).find(v => /^[\d,]+$/.test(String(v)) && Number(String(v).replace(/,/g,'')) < 1_000_000 && Number(String(v).replace(/,/g,'')) > 0);

        const date   = normalizeDate(rawDate);
        const amount = parseFloat(String(rawAmt ?? 0).replace(/,/g,''));
        if (date && amount > 0) history.push({ date, amount });
      }
      if (history.length) {
        dbg.push({ step: 'krx_ok1', count: history.length });
        return buildResult(ticker, history, 'KRW');
      }
    }
  } catch (e) {
    dbg.push({ step: 'krx_error1', error: e.message });
  }

  // ── 시도 2: ETF 분배금 (다른 bld 코드) ──────────────────────────────────
  const altBlds = [
    'dbms/MDC/STAT/standard/MDCSTAT04501',
    'dbms/MDC/STAT/standard/MDCSTAT04301',
    'dbms/MDC/STAT/standard/MDCSTAT04101',
  ];

  for (const bld of altBlds) {
    try {
      const otp = await krxGenerateOtp({ bld, isuCd: code, strtDd: startDt, endDd: endDt });
      const data = await krxDownload(otp);
      const sample = JSON.stringify(data).slice(0, 300);
      dbg.push({ step: 'krx_alt', bld, sample });

      const rows = Array.isArray(data) ? data
        : data?.output ?? data?.OutBlock_1 ?? data?.result ?? data?.list ?? [];
      if (Array.isArray(rows) && rows.length) {
        dbg.push({ step: 'krx_alt_rows', bld, count: rows.length, first: rows[0] });
        // 컬럼명 확인 후 분배금 데이터가 맞으면 파싱
        const keys = Object.keys(rows[0] ?? {});
        const hasDiv = keys.some(k => /분배|배당|DVD/i.test(k));
        if (hasDiv) {
          const history = [];
          for (const row of rows) {
            const rawDate = Object.entries(row).find(([k]) => /기준일|BAS_DD/i.test(k))?.[1];
            const rawAmt  = Object.entries(row).find(([k]) => /분배금|배당금|DVD_AMT/i.test(k))?.[1];
            const date    = normalizeDate(rawDate);
            const amount  = parseFloat(String(rawAmt ?? 0).replace(/,/g,''));
            if (date && amount > 0) history.push({ date, amount });
          }
          if (history.length) {
            dbg.push({ step: 'krx_alt_ok', bld, count: history.length });
            return buildResult(ticker, history, 'KRW');
          }
        }
      }
    } catch (e) {
      dbg.push({ step: 'krx_alt_error', bld, error: e.message });
    }
  }

  return null;
}

// ── 해외: Yahoo Finance ───────────────────────────────────────────────────
async function fetchYahooDividend(ticker) {
  const yahooTicker = toYahooTicker(ticker);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?range=2y&interval=1mo&events=div&includePrePost=false`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;
    const divEvents = result.events?.dividends;
    if (!divEvents || !Object.keys(divEvents).length) return null;
    const history = Object.values(divEvents).map(e => ({
      date:   new Date(e.date * 1000).toISOString().slice(0, 10),
      amount: e.amount,
    }));
    return buildResult(ticker, history, result.meta?.currency || 'USD');
  } catch { return null; }
}

// ── 메인 핸들러 ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const tickers   = (req.query.tickers || '').split(',').map(t => t.trim()).filter(Boolean);
  const debugMode = req.query.debug === '1';

  if (!tickers.length) {
    return res.status(400).json({ error: 'tickers 파라미터가 필요합니다.' });
  }

  const dividends = {};
  const noData    = [];
  const debugInfo = {};

  await Promise.all(tickers.map(async ticker => {
    const dbg = [];
    try {
      const data = isKoreanTicker(ticker)
        ? await fetchKrxDividend(ticker, dbg)
        : await fetchYahooDividend(ticker);

      if (data) dividends[ticker] = data;
      else      noData.push(ticker);
    } catch (e) {
      noData.push(ticker);
      dbg.push({ step: 'error', message: e.message });
    }
    if (debugMode) debugInfo[ticker] = dbg;
  }));

  res.setHeader('Cache-Control', debugMode
    ? 'no-store'
    : 'public, s-maxage=21600, stale-while-revalidate=3600');

  return res.json({
    updatedAt: new Date().toISOString(),
    dividends,
    meta: { total: tickers.length, success: Object.keys(dividends).length, noData },
    ...(debugMode && { debug: debugInfo }),
  });
}
