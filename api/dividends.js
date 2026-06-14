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

// ── ① WiseReport 직접 AJAX API 시도 ─────────────────────────────────────
// navercomp.wisereport.co.kr 가 내부적으로 호출하는 실제 데이터 URL들
async function fetchWiseReport(code, dbg) {
  // WiseReport ASP.NET AJAX 패턴: index.aspx가 호출하는 하위 aspx 직접 요청
  const today = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const twoYearsAgo = new Date(Date.now() - 2*365*24*3600*1000).toISOString().slice(0,10).replace(/-/g,'');

  const candidates = [
    // 분배금 직접 URL 패턴들
    `https://navercomp.wisereport.co.kr/v2/ETF/etf_dvpay.aspx?cmp_cd=${code}`,
    `https://navercomp.wisereport.co.kr/v2/ETF/etf_dvpay.aspx?cmp_cd=${code}&start_dt=${twoYearsAgo}&end_dt=${today}`,
    `https://navercomp.wisereport.co.kr/v2/ETF/GetDvPayData.aspx?cmp_cd=${code}`,
    `https://navercomp.wisereport.co.kr/v2/ETF/etf_dvpay_data.aspx?cmp_cd=${code}`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: {
          ...NAVER_HEADERS,
          'Referer': `https://navercomp.wisereport.co.kr/v2/ETF/index.aspx?cmp_cd=${code}&target=etf_dvpay`,
          'Host': 'navercomp.wisereport.co.kr',
        },
        signal: AbortSignal.timeout(6000),
      });
      dbg.push({ step: 'wisereport_try', url, status: res.status });
      if (!res.ok) continue;

      const text = await res.text();
      dbg.push({ step: 'wisereport_got', url, len: text.length, sample: text.slice(0, 300) });

      // JSON 응답인 경우
      try {
        const json = JSON.parse(text);
        const list = json?.result ?? json?.data ?? json?.list ?? json?.rows ?? [];
        if (Array.isArray(list) && list.length) {
          dbg.push({ step: 'wisereport_json', count: list.length, first: list[0] });
          const history = [];
          for (const item of list) {
            const rawDate = Object.values(item).find(v => /\d{8}/.test(String(v))) ?? '';
            const date = String(rawDate).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
            const amount = parseFloat(String(Object.values(item).find(v => /^\d+$/.test(String(v)) && Number(v) < 1_000_000 && Number(v) > 0) ?? 0));
            if (/^\d{4}-\d{2}-\d{2}$/.test(date) && amount > 0) history.push({ date, amount });
          }
          if (history.length) return buildResult(code, history, 'KRW');
        }
      } catch {}

      // HTML 응답인 경우 — td 파싱
      const history = [];
      const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let tr;
      while ((tr = trRe.exec(text)) !== null) {
        const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
          .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g,'').trim());
        if (!cells.length) continue;
        const m = cells[0].match(/(\d{4})[.\-]?(\d{2})[.\-]?(\d{2})/);
        if (m) {
          const date = `${m[1]}-${m[2]}-${m[3]}`;
          for (let i = 1; i < cells.length; i++) {
            const amount = parseFloat(cells[i].replace(/,/g,''));
            if (!isNaN(amount) && amount > 0 && amount < 1_000_000) {
              history.push({ date, amount }); break;
            }
          }
        }
      }
      if (history.length) {
        dbg.push({ step: 'wisereport_html_ok', count: history.length });
        return buildResult(code, history, 'KRW');
      }
    } catch (e) {
      dbg.push({ step: 'wisereport_error', url, error: e.message });
    }
  }

  // WiseReport JS 파일에서 실제 AJAX URL 추출 시도
  try {
    const jsRes = await fetch(`https://navercomp.wisereport.co.kr/v2/ETF/index.aspx?cmp_cd=${code}&target=etf_dvpay`, {
      headers: NAVER_HEADERS, signal: AbortSignal.timeout(8000),
    });
    if (jsRes.ok) {
      const html = await jsRes.text();
      // script src 추출
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/gi)].map(m=>m[1]);
      dbg.push({ step: 'wisereport_scripts', scripts });
      // 인라인 JS에서 dvpay 관련 URL 패턴 찾기
      const ajaxUrls = [...html.matchAll(/url\s*:\s*["']([^"']*dvpay[^"']*)["']/gi)].map(m=>m[1]);
      const ajaxUrls2 = [...html.matchAll(/["']([^"']*etf_dv[^"']*)["']/gi)].map(m=>m[1]);
      dbg.push({ step: 'wisereport_ajax_urls', ajaxUrls: [...ajaxUrls, ...ajaxUrls2].slice(0,10) });
    }
  } catch (e) {
    dbg.push({ step: 'wisereport_js_error', error: e.message });
  }

  return null;
}

// ── ② 네이버 ETF 분배금 JSON API (여러 URL 패턴 시도) ───────────────────
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

// ── ③ 네이버 ETF 분배금 전용 URL 시도 ───────────────────────────────────
async function fetchNaverStockHtml(code, dbg) {
  // ETF 분배금은 target=etf_dvpay 또는 target=divpay
  const candidates = [
    `https://finance.naver.com/item/coinfo.naver?code=${code}&target=etf_dvpay`,
    `https://finance.naver.com/item/coinfo.naver?code=${code}&target=divpay`,
  ];

  for (const url of candidates) {
    try {
      const { ok, status, html, encoding, contentType } = await fetchKrHtml(url);
      dbg.push({ step: 'naver_coinfo_try', url, status, htmlLen: html?.length ?? 0, encoding, contentType });
      if (!ok || !html) continue;

      // iframe 탐지 (분배금 테이블이 iframe으로 로드될 수 있음)
      const iframes = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
      if (iframes.length) dbg.push({ step: 'coinfo_iframes', url, iframes });

      // 키워드 탐지
      for (const kw of ['분배기준일', '분배금', '배당기준일', 'dvpay', 'divpay']) {
        const idx = html.indexOf(kw);
        if (idx >= 0) {
          dbg.push({ step: `coinfo_keyword_${kw}`, ctx: html.slice(Math.max(0,idx-80), idx+500) });
        }
      }

      // td 날짜 기반 파싱
      const history = [];
      const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let tr;
      while ((tr = trRe.exec(html)) !== null) {
        const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
          .map(c => c[1].replace(/<[^>]+>/g, '').trim());
        if (cells.length >= 2 && /^\d{4}\.\d{2}\.\d{2}$/.test(cells[0])) {
          const date = cells[0].replace(/\./g, '-');
          for (let i = 1; i < cells.length; i++) {
            const amount = parseFloat(cells[i].replace(/,/g, ''));
            if (!isNaN(amount) && amount > 0 && amount < 1_000_000) {
              history.push({ date, amount });
              break;
            }
          }
        }
      }

      // iframe에서 분배금 직접 조회 (wisereport.co.kr)
      for (const iframeSrc of iframes) {
        const fullUrl = iframeSrc.startsWith('http') ? iframeSrc : `https://finance.naver.com${iframeSrc}`;
        const { ok: iok, html: ihtml, encoding: ienc } = await fetchKrHtml(fullUrl);
        dbg.push({ step: 'coinfo_iframe_fetch', src: fullUrl, ok: iok, len: ihtml?.length ?? 0, encoding: ienc });
        if (!iok || !ihtml) continue;

        // 디버그: 날짜 패턴 주변 HTML 구조 확인
        const datePatterns = [
          /\d{4}\.\d{2}\.\d{2}/,   // 2024.03.08
          /\d{4}-\d{2}-\d{2}/,     // 2024-03-08
          /\d{4}년\s*\d{1,2}월\s*\d{1,2}일/, // 2024년 3월 8일
          /\d{8}/,                  // 20240308
        ];
        for (const pat of datePatterns) {
          const m = ihtml.match(pat);
          if (m) {
            const idx = ihtml.indexOf(m[0]);
            dbg.push({ step: 'iframe_date_found', pattern: pat.toString(), date: m[0],
              ctx: ihtml.slice(Math.max(0,idx-150), idx+400) });
            break;
          }
        }

        // wisereport 구조: td 내부 텍스트 추출 (중첩 태그 포함)
        const iRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
        let itr;
        while ((itr = iRe.exec(ihtml)) !== null) {
          const cells = [...itr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
            .map(c => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
          if (!cells.length) continue;

          // 날짜 형식 다양하게 탐지
          let date = null;
          const dateCell = cells[0];
          const m1 = dateCell.match(/(\d{4})\.(\d{2})\.(\d{2})/);
          const m2 = dateCell.match(/(\d{4})-(\d{2})-(\d{2})/);
          const m3 = dateCell.match(/(\d{4})(\d{2})(\d{2})/);
          if (m1) date = `${m1[1]}-${m1[2]}-${m1[3]}`;
          else if (m2) date = `${m2[1]}-${m2[2]}-${m2[3]}`;
          else if (m3 && m3[0].length === 8) date = `${m3[1]}-${m3[2]}-${m3[3]}`;

          if (date) {
            for (let i = 1; i < cells.length; i++) {
              const amount = parseFloat(cells[i].replace(/,/g, ''));
              if (!isNaN(amount) && amount > 0 && amount < 1_000_000) {
                history.push({ date, amount });
                break;
              }
            }
          }
        }
      }

      dbg.push({ step: 'naver_coinfo_rows', url, count: history.length, sample: history.slice(0,3) });
      if (history.length) return buildResult(code, history, 'KRW');
    } catch (e) {
      dbg.push({ step: 'naver_coinfo_error', url, error: e.message });
    }
  }
  return null;
}

// ── 국내 배당 메인 ────────────────────────────────────────────────────────
async function fetchKoreanDividend(ticker, dbg) {
  const code = getKrCode(ticker);

  // 0) WiseReport 직접 AJAX API (가장 정확한 소스)
  let result = await fetchWiseReport(code, dbg);
  if (result) { result.source = 'wisereport'; return result; }

  // 1) 네이버 ETF JSON API
  result = await fetchNaverEtfJson(code, dbg);
  if (result) { result.source = 'naver_json'; return result; }

  // 2) 네이버 ETF HTML
  result = await fetchNaverEtfHtml(code, dbg);
  if (result) { result.source = 'naver_etf_html'; return result; }

  // 3) 네이버 coinfo HTML
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
