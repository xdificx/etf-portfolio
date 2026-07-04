/**
 * Vercel Serverless Function — /api/toss-holdings
 *
 * GET /api/toss-holdings
 * 토스증권 계좌의 보유 주식을 조회합니다.
 *
 * 환경변수 (Vercel Dashboard > Settings > Environment Variables):
 *   Toss_API_Key     — 토스증권 Open API client_id
 *   Toss_Secret_Key — 토스증권 Open API client_secret
 */

const TOSS_BASE = 'https://openapi.tossinvest.com';

let _token    = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;

  const clientId     = process.env.Toss_API_Key;
  const clientSecret = process.env.Toss_Secret_Key;
  if (!clientId || !clientSecret) throw new Error('Toss_API_Key / Toss_Secret_Key 환경변수가 설정되지 않았습니다.');

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

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Toss 토큰 발급 실패 (HTTP ${res.status}): ${text}`);
  }

  const d = await res.json();
  if (!d.access_token) throw new Error('Toss 토큰 발급 실패: ' + JSON.stringify(d));

  _token    = d.access_token;
  _tokenExp = Date.now() + 55 * 60 * 1000; // 55분
  return _token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.Toss_API_Key || !process.env.Toss_Secret_Key) {
    return res.status(503).json({ error: 'Toss API 환경변수 미설정 (Toss_API_Key, Toss_Secret_Key)' });
  }

  try {
    const token = await getToken();

    // 1) 계좌 목록 조회
    const accountsRes = await fetch(`${TOSS_BASE}/api/v1/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  AbortSignal.timeout(8000),
    });
    if (!accountsRes.ok) {
      const text = await accountsRes.text().catch(() => '');
      throw new Error(`계좌 조회 실패 (HTTP ${accountsRes.status}): ${text}`);
    }
    const accountsData = await accountsRes.json();
    const accounts     = accountsData.result || [];

    if (!accounts.length) {
      return res.json({ holdings: [], accounts: [], updatedAt: new Date().toISOString() });
    }

    // 2) 각 계좌별 보유 주식 조회
    const allHoldings = [];
    const accountMeta = [];

    for (const account of accounts) {
      const acctSeq = String(account.accountSeq ?? account.seq ?? account.id ?? '');
      accountMeta.push({ seq: acctSeq, name: account.name || acctSeq });

      const holdRes = await fetch(`${TOSS_BASE}/api/v1/holdings`, {
        headers: {
          Authorization:          `Bearer ${token}`,
          'X-Tossinvest-Account': acctSeq,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!holdRes.ok) {
        console.warn(`계좌 ${acctSeq} 보유주식 조회 실패: HTTP ${holdRes.status}`);
        continue;
      }

      const holdData = await holdRes.json();
      // result가 { items, overview } 구조 or 배열 모두 처리
      const items = Array.isArray(holdData.result)
        ? holdData.result
        : (holdData.result?.items || []);

      for (const item of items) {
        allHoldings.push({
          accountSeq:           acctSeq,
          symbol:               item.symbol,
          name:                 item.name,
          marketCountry:        item.marketCountry,   // "KR" | "US"
          currency:             item.currency,         // "KRW" | "USD"
          quantity:             parseFloat(item.quantity    ?? 0),
          lastPrice:            parseFloat(item.lastPrice   ?? 0),
          averagePurchasePrice: parseFloat(item.averagePurchasePrice ?? 0),
        });
      }
    }

    return res.json({
      holdings:   allHoldings,
      accounts:   accountMeta,
      updatedAt:  new Date().toISOString(),
    });

  } catch (e) {
    console.error('toss-holdings error:', e.message);
    return res.status(502).json({ error: e.message });
  }
}
