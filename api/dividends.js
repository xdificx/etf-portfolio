/**
 * Vercel Serverless Function — /api/dividends
 *
 * GET /api/dividends?tickers=SPY,AAPL,069500.KS,0177N0
 *
 * 국내 ETF/주식 → 네이버 Finance (JSON API → ETF HTML → 주식 HTML 순서)
 * 해외 ETF/주식 → Yahoo Finance
 */

// ── 티커 판별 ─────────────────────────────────────────────────────────────
function isKoreanTicker(ticker) {
  return /\.(KS|KQ|KP)$/i.test(ticker) || /^\d[A-Z0-9]{5}$/i.test(ticker);
}

function getKrCode(ticker) {
  // "069500.KS" → "069500",  "0177N0" → "0177N0"
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
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if      (avgGap < 45)  return 'monthly';
  else if (avgGap < 120) return 'quarterly';
  else if (avgGap < 270) return 'semi-annual';
  else                   return 'annual';
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
    history:    history.slice(-12),
    currency,
    fetchedAt:  new Date().toISOString(),
  };
}

// ── 네이버 공통 헤더 ─────────────────────────────────────────────────────
const NAVER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer':         'https://finance.naver.com',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  'Accept':          'application/json, text/html, */*',
};

// ── ① 네이버 ETF 분배금 JSON API ─────────────────────────────────────────
// 네이버 증권 앱 내부 REST API — 분배금 이력을 JSON으로 반환
async function fetchNaverEtfJson(code) {
  const url = `https://api.stock.naver.com/api/item/etf/${code}/distribution?page=1&pageSize=24`;
  try {
    const res = await fetch(url, {
      headers: NAVER_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const json = await res.json();

    // 응답 구조: { distributionList: [{standardDate, distribution, ...}] }
    // 또는 { list: [...] } 형태일 수 있음
    const list = json?.distributionList ?? json?.list ?? json?.data ?? [];
    if (!Array.isArray(list) || !list.length) return null;

    const history = [];
    for (const item of list) {
      const rawDate = item.standardDate ?? item.date ?? item.exDate ?? '';
      const date    = rawDate.replace(/\./g, '-');   // "2024.03.08" → "2024-03-08"
      const amount  = parseFloat(
        String(item.distribution ?? item.amount ?? item.divAmount ?? 0).replace(/,/g, '')
      );
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && amount > 0) {
        history.push({ date, amount });
      }
    }
    return history.length ? buildResult(code, history, 'KRW') : null;
  } catch (e) {
    console.warn(`네이버 ETF JSON API 실패 (${code}):`, e.message);
    return null;
  }
}

// ── ② 네이버 ETF 페이지 HTML 스크래핑 ───────────────────────────────────
async function fetchNaverEtfHtml(code) {
  const url = `https://finance.naver.com/fund/etfItemInfo.naver?itemCode=${code}`;
  try {
    const res = await fetch(url, {
      headers: NAVER_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const history = [];

    // 패턴 A: "분배기준일" 섹션 이후 날짜+금액 td 순서 파싱
    const section = html.match(/분배기준일[\s\S]{0,8000}/);
    if (section) {
      // <td>2024.03.08</td> ... <td>50</td> 형태
      const rowRe = /(\d{4}\.\d{2}\.\d{2})<\/td>[\s\S]*?<td[^>]*>\s*([\d,]+)\s*<\/td>/g;
      let m;
      while ((m = rowRe.exec(section[0])) !== null) {
        const date   = m[1].replace(/\./g, '-');
        const amount = parseFloat(m[2].replace(/,/g, ''));
        if (amount > 0) history.push({ date, amount });
      }
    }

    // 패턴 B: 보다 느슨한 날짜 매칭
    if (!history.length) {
      const altRe = /(\d{4})\.(\d{2})\.(\d{2})[^<]*<\/td>[\s\S]*?<td[^>]*>\s*([\d,]+)\s*<\/td>/g;
      let m2;
      while ((m2 = altRe.exec(html)) !== null) {
        const date   = `${m2[1]}-${m2[2]}-${m2[3]}`;
        const amount = parseFloat(m2[4].replace(/,/g, ''));
        if (amount > 0 && amount < 1000000) history.push({ date, amount });
      }
    }

    return history.length ? buildResult(code, history, 'KRW') : null;
  } catch (e) {
    console.warn(`네이버 ETF HTML 스크래핑 실패 (${code}):`, e.message);
    return null;
  }
}

// ── ③ 네이버 주식 배당 페이지 HTML 스크래핑 ─────────────────────────────
// 일반 주식(삼성전자 등) 배당 이력 — ETF가 아닌 경우 폴백
async function fetchNaverStockHtml(code) {
  const url = `https://finance.naver.com/item/coinfo.naver?code=${code}&target=divpay`;
  try {
    const res = await fetch(url, {
      headers: NAVER_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const history = [];

    // 배당기준일 + 현금 배당금 패턴
    const re = /(\d{4}\.\d{2}\.\d{2})<\/td>[\s\S]*?현금[\s\S]*?<td[^>]*>\s*([\d,]+)\s*<\/td>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const date   = m[1].replace(/\./g, '-');
      const amount = parseFloat(m[2].replace(/,/g, ''));
      if (amount > 0) history.push({ date, amount });
    }

    // 폴백: 현금 구분 없이 날짜+금액만
    if (!history.length) {
      const altRe = /(\d{4})\.(\d{2})\.(\d{2})<\/td>[\s\S]*?<td[^>]*>\s*([\d,]+)\s*원?<\/td>/g;
      let m2;
      while ((m2 = altRe.exec(html)) !== null) {
        const date   = `${m2[1]}-${m2[2]}-${m2[3]}`;
        const amount = parseFloat(m2[4].replace(/,/g, ''));
        if (amount > 0 && amount < 1000000) history.push({ date, amount });
      }
    }

    return history.length ? buildResult(code, history, 'KRW') : null;
  } catch (e) {
    console.warn(`네이버 주식 배당 HTML 실패 (${code}):`, e.message);
    return null;
  }
}

// ── 국내 배당 메인: JSON → ETF HTML → 주식 HTML ─────────────────────────
async function fetchKoreanDividend(ticker) {
  const code = getKrCode(ticker);
  console.log(`국내 배당 조회: ${ticker} (code=${code})`);

  // 1) 네이버 ETF JSON API
  let result = await fetchNaverEtfJson(code);
  if (result) {
    console.log(`✓ 네이버 ETF JSON: ${ticker} → ${result.frequency} / ${result.avgAmount}원`);
    return result;
  }

  // 2) 네이버 ETF HTML
  result = await fetchNaverEtfHtml(code);
  if (result) {
    console.log(`✓ 네이버 ETF HTML: ${ticker} → ${result.frequency} / ${result.avgAmount}원`);
    return result;
  }

  // 3) 네이버 주식 배당 HTML
  result = await fetchNaverStockHtml(code);
  if (result) {
    console.log(`✓ 네이버 주식 HTML: ${ticker} → ${result.frequency} / ${result.avgAmount}원`);
    return result;
  }

  console.warn(`✗ 국내 배당 데이터 없음: ${ticker}`);
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
  } catch (e) {
    console.warn(`Yahoo 배당 실패 (${ticker}):`, e.message);
    return null;
  }
}

// ── 메인 핸들러 ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const tickers = (req.query.tickers || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (!tickers.length) {
    return res.status(400).json({ error: 'tickers 파라미터가 필요합니다.' });
  }

  const dividends = {};
  const noData    = [];

  await Promise.all(tickers.map(async ticker => {
    try {
      const data = isKoreanTicker(ticker)
        ? await fetchKoreanDividend(ticker)
        : await fetchYahooDividend(ticker);

      if (data) dividends[ticker] = data;
      else      noData.push(ticker);
    } catch (e) {
      noData.push(ticker);
      console.error(`배당 오류 ${ticker}:`, e.message);
    }
  }));

  // 6시간 CDN 캐시
  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');

  return res.json({
    updatedAt: new Date().toISOString(),
    dividends,
    meta: {
      total:   tickers.length,
      success: Object.keys(dividends).length,
      noData,
    },
  });
}
