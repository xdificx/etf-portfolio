/**
 * Vercel Serverless Function — /api/trading-day
 *
 * GET /api/trading-day                        → {trading, date, reason}  ← 오늘 확인
 * GET /api/trading-day?date=2026-06-20        → {trading, date, reason}  ← 특정일 확인
 * GET /api/trading-day?from=YYYY-MM-DD&to=YYYY-MM-DD
 *                                             → {count, dates, from, to} ← 범위 내 개장일 목록
 */

// ── NYSE 정규 휴장일 (2024–2027) ──────────────────────────────────────────
// 출처: NYSE 공식 공지 + 미국 연방 공휴일 규정
const NYSE_HOLIDAYS = new Set([
  // 2024
  '2024-01-01', // 신정
  '2024-01-15', // MLK Day
  '2024-02-19', // Presidents' Day
  '2024-03-29', // Good Friday
  '2024-05-27', // Memorial Day
  '2024-06-19', // Juneteenth
  '2024-07-04', // Independence Day
  '2024-09-02', // Labor Day
  '2024-11-28', // Thanksgiving
  '2024-12-25', // Christmas
  // 2025
  '2025-01-01', // 신정
  '2025-01-09', // 지미 카터 전 대통령 국장 (추가 휴장)
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents' Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // 신정
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday (Easter: 4/5)
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day observed (7/4 토요일)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01', // 신정
  '2027-01-18', // MLK Day
  '2027-02-15', // Presidents' Day
  '2027-04-23', // Good Friday (Easter: 4/25)
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth observed (6/19 토요일)
  '2027-07-05', // Independence Day observed (7/4 일요일)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas observed (12/25 토요일)
]);

// ── 헬퍼 ─────────────────────────────────────────────────────────────────
function isTradingDay(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;      // 주말
  if (NYSE_HOLIDAYS.has(dateStr)) return false;  // 공휴일
  return true;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function reason(dateStr) {
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return 'weekend';
  if (NYSE_HOLIDAYS.has(dateStr)) return 'holiday';
  return 'open';
}

// ── 메인 핸들러 ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date, from, to } = req.query;

  // ① 범위 조회: ?from=YYYY-MM-DD&to=YYYY-MM-DD
  if (from && to) {
    if (from > to) return res.status(400).json({ error: 'from must be ≤ to' });
    const tradingDays = [];
    let cur = from;
    // 최대 2년(730일) 제한
    let limit = 730;
    while (cur <= to && limit-- > 0) {
      if (isTradingDay(cur)) tradingDays.push(cur);
      cur = addDays(cur, 1);
    }
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.json({ from, to, count: tradingDays.length, dates: tradingDays });
  }

  // ② 단일 날짜 조회: ?date=YYYY-MM-DD  or  기본값(오늘)
  const target = date || new Date().toISOString().slice(0, 10);
  const trading = isTradingDay(target);
  res.setHeader('Cache-Control', 'public, s-maxage=3600');
  return res.json({ date: target, trading, reason: reason(target) });
}
