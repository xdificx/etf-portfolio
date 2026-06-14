/**
 * Vercel Serverless Function — /api/dividends
 *
 * GET /api/dividends?tickers=SPY,069500.KS,0177N0
 * GET /api/dividends?tickers=069500.KS&debug=1   ← 오류 원인 확인용
 *
 * 국내 ETF/주식 → 네이버 Finance (JSON API → ETF HTML → 주식 HTML 순서)
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
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// 네이버 HTML을 올바른 인코딩으로 읽기
// Content-Type charset을 우선 확인하고, 없으면 HTML meta charset 확인
async function fetchKrHtml(url) {
  const res = await fetch(url, {
    headers: NAVER_HEADERS,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return { ok: false, status: res.status, html: null, encoding: null };

  const contentType = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();

  // 1) Content-Type 헤더에서 charset 확인
  let encoding = 'utf-8';
  if (/euc-kr|euckr|cp949/i.test(contentType)) {
    encoding = 'euc-kr';
  } else if (/utf-8/i.test(contentType)) {
    encoding = 'utf-8';
  } else {
    // 2) 헤더에 charset 없으면 HTML 앞부분에서 meta charset 탐지
    const preview = new TextDecoder('ascii', { fatal: false }).decode(buf.slice(0, 1024));
    if (/euc-kr|euckr|cp949/i.test(preview)) encoding = 'euc-kr';
  }

  try {
    const html = new TextDecoder(encoding, { fatal: false }).decode(buf);
    return { ok: true, status: res.status, html, encoding, contentType };
  } catch {
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { ok: true, status: res.status, html, encoding: 'utf-8-fallback', contentType };
  }
}

// ── ① 네이버 ETF 분배금 JSON API (여러 URL 패턴 시도) ───────────────────
async function fetchNaverEtfJson(code, dbg) {
  const candidates = [
    `https://api.stock.naver.com/api/item/etf/${code}/distribution?page=1&pageSize=24`,
    `https://m.stock.naver.com/api/item/etf/${code}/distribution?page=1&pageSize=24`,
    `https://api.stock.naver.com/api/item/domesticStock/etf/${code}/distribution`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: { ...NAVER_HEADERS, Accept: 'application/json, */*' },
        signal: AbortSignal.timeout(5000),
      });
      dbg.push({ step: 'naver_json_try', url, status: res.status });
      if (!res.ok) continue;

      const json = await res.json();
      dbg.push({ step: 'naver_json_body', url, keys: Object.keys(json), sample: JSON.stringify(json).slice(0, 400) });

      const list = json?.distributionList ?? json?.list ?? json?.data ?? json?.result ?? [];
      if (!Array.isArray(list) || !list.length) continue;

      const history = [];
      for (const item of list) {
        const rawDate = item.standardDate ?? item.date ?? item.exDate ?? '';
        const date    = rawDate.replace(/\./g, '-');
        const amount  = parseFloat(
          String(item.distribution ?? item.amount ?? item.divAmount ?? 0).replace(/,/g, '')
        );
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && amount > 0) {
          history.push({ date, amount });
        }
      }
      if (history.length) return buildResult(code, history, 'KRW');
    } catch (e) {
      dbg.push({ step: 'naver_json_error', url, error: e.message });
    }
  }
  return null;
}

// ── ② 네이버 ETF 분배금 HTML (여러 URL + iframe 탐지) ───────────────────
async function fetchNaverEtfHtml(code, dbg) {
  const candidates = [
    `https://finance.naver.com/fund/etfItemDetail.naver?itemCode=${code}`,
    `https://finance.naver.com/item/main.naver?code=${code}`,
    `https://finance.naver.com/fund/etfDividend.naver?itemCode=${code}`,
  ];

  for (const url of candidates) {
    try {
      const { ok, status, html, encoding, contentType } = await fetchKrHtml(url);
      dbg.push({ step: 'naver_etf_html_try', url, status, htmlLen: html?.length ?? 0, encoding, contentType });
      if (!ok || !html) continue;

      // iframe URL 탐지
      const iframes = [...html.matchAll(/<iframe[^>]+src="([^"]+)"/gi)].map(m => m[1]);
      if (iframes.length) dbg.push({ step: 'iframes_found', url, iframes });

      // 키워드 탐지 + 주변 샘플
      for (const kw of ['분배기준일', '분배금', '배당기준일']) {
        const idx = html.indexOf(kw);
        if (idx >= 0) {
          dbg.push({ step: `keyword_${kw}`, url, ctx: html.slice(Math.max(0,idx-50), idx+400) });
          break;
        }
      }

      const history = [];
      const section = html.match(/(분배기준일|배당기준일)[\s\S]{0,8000}/);
      if (section) {
        const rowRe = /(\d{4}\.\d{2}\.\d{2})<\/td>[\s\S]*?<td[^>]*>\s*([\d,]+)\s*<\/td>/g;
        let m;
        while ((m = rowRe.exec(section[0])) !== null) {
          const date   = m[1].replace(/\./g, '-');
          const amount = parseFloat(m[2].replace(/,/g, ''));
          if (amount > 0) history.push({ date, amount });
        }
      }

      // 관련 iframe 직접 조회
      for (const iframeSrc of iframes) {
        if (!/div|distrib|etf/i.test(iframeSrc)) continue;
        const fullUrl = iframeSrc.startsWith('http') ? iframeSrc : `https://finance.naver.com${iframeSrc}`;
        const { ok: iok, html: ihtml } = await fetchKrHtml(fullUrl);
        dbg.push({ step: 'iframe_fetch', src: fullUrl, ok: iok, len: ihtml?.length ?? 0 });
        if (!iok || !ihtml) continue;
        const iRe = /(\d{4}\.\d{2}\.\d{2})<\/td>[\s\S]*?<td[^>]*>\s*([\d,]+)\s*<\/td>/g;
        let im;
        while ((im = iRe.exec(ihtml)) !== null) {
          const date   = im[1].replace(/\./g, '-');
          const amount = parseFloat(im[2].replace(/,/g, ''));
          if (amount > 0 && amount < 1_000_000) history.push({ date, amount });
        }
      }

      if (history.length) {
        dbg.push({ step: 'naver_etf_html_ok', url, count: history.length });
        return buildResult(code, history, 'KRW');
      }
    } catch (e) {
      dbg.push({ step: 'naver_etf_html_error', error: e.message });
    }
  }
  return null;
}

// ── ③ 네이버 배당/분배금 HTML 스크래핑 ──────────────────────────────────
async function fetchNaverStockHtml(code, dbg) {
  const url = `https://finance.naver.com/item/coinfo.naver?code=${code}&target=divpay`;
  try {
    const { ok, status, html, encoding, contentType } = await fetchKrHtml(url);
    dbg.push({ step: 'naver_stock_html', url, status, htmlLen: html?.length ?? 0, encoding, contentType });
    if (!ok || !html) return null;

    // 디버그: 날짜 패턴 주변 HTML 샘플 확인
    const dateMatch = html.match(/\d{4}\.\d{2}\.\d{2}/);
    if (dateMatch) {
      const idx = html.indexOf(dateMatch[0]);
      dbg.push({ step: 'naver_stock_html_sample', near_date: html.slice(Math.max(0,idx-100), idx+300) });
    } else {
      // 날짜가 없으면 테이블 구조 확인
      const tblMatch = html.match(/<table[\s\S]{0,2000}/);
      dbg.push({ step: 'naver_stock_html_notable', sample: tblMatch?.[0]?.slice(0,400) ?? '테이블 없음' });
    }

    const history = [];

    // 패턴 A: 날짜 바로 뒤 <tr> 안의 숫자들 (현금/분배금 구분 없이)
    // 분배금은 "현금" 없이 날짜 + 금액만 있을 수 있음
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let tr;
    while ((tr = trRe.exec(html)) !== null) {
      const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map(c => c[1].replace(/<[^>]+>/g, '').trim());
      // 첫 번째 셀이 날짜 형식인 행 탐색
      if (cells.length >= 2 && /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0])) {
        const date = cells[0].replace(/\./g, '-');
        // 숫자 셀 찾기 (두 번째 이후 셀 중 순수 숫자+콤마)
        for (let i = 1; i < cells.length; i++) {
          const raw = cells[i].replace(/,/g, '');
          const amount = parseFloat(raw);
          if (!isNaN(amount) && amount > 0 && amount < 1_000_000) {
            history.push({ date, amount });
            break;
          }
        }
      }
    }

    dbg.push({ step: 'naver_stock_html_rows', count: history.length, sample: history.slice(0,3) });
    return history.length ? buildResult(code, history, 'KRW') : null;
  } catch (e) {
    dbg.push({ step: 'naver_stock_html_error', error: e.message });
    return null;
  }
}

// ── 국내 배당 메인 ────────────────────────────────────────────────────────
async function fetchKoreanDividend(ticker, dbg) {
  const code = getKrCode(ticker);

  let result = await fetchNaverEtfJson(code, dbg);
  if (result) { result.source = 'naver_json'; return result; }

  result = await fetchNaverEtfHtml(code, dbg);
  if (result) { result.source = 'naver_etf_html'; return result; }

  result = await fetchNaverStockHtml(code, dbg);
  if (result) { result.source = 'naver_stock_html'; return result; }

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

  const tickers  = (req.query.tickers || '').split(',').map(t => t.trim()).filter(Boolean);
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
        ? await fetchKoreanDividend(ticker, dbg)
        : await fetchYahooDividend(ticker);

      if (data) dividends[ticker] = data;
      else      noData.push(ticker);
    } catch (e) {
      noData.push(ticker);
      dbg.push({ step: 'handler_error', error: e.message });
    }
    if (debugMode) debugInfo[ticker] = dbg;
  }));

  // 디버그 모드에서는 캐시 비활성화
  if (debugMode) {
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
  }

  return res.json({
    updatedAt: new Date().toISOString(),
    dividends,
    meta: { total: tickers.length, success: Object.keys(dividends).length, noData },
    ...(debugMode && { debug: debugInfo }),
  });
}
