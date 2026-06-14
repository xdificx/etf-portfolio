#!/usr/bin/env python3
"""
ETF 포트폴리오 일일 수익률 체크
────────────────────────────────
사용법:
  python3 daily_check.py              # 일반 실행 (터미널 + 맥 알림)
  python3 daily_check.py --no-notify  # 터미널 출력만

설정:
  portfolio.json 파일에 보유 ETF를 입력하세요.
  (웹 대시보드 → 설정 → 데이터 내보내기 → portfolio.json으로 저장)
"""

import json, sys, subprocess
import urllib.request, urllib.error
from pathlib import Path
from datetime import datetime

SCRIPT_DIR     = Path(__file__).parent
PORTFOLIO_FILE = SCRIPT_DIR / 'portfolio.json'
NOTIFY         = '--no-notify' not in sys.argv

# ── 설정 ──────────────────────────────────────────────────────
# 웹 대시보드 URL (있으면 알림 클릭 시 열림)
# 예: 'https://본인아이디.github.io/etf-portfolio'
DASHBOARD_URL = ''


# ── Yahoo Finance 가격 조회 ────────────────────────────────────
def fetch_price(ticker: str) -> dict | None:
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1d&interval=1d'
    proxied = f'https://api.allorigins.win/raw?url={urllib.request.quote(url, safe="")}'

    for u in [url, proxied]:
        try:
            req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            meta  = data['chart']['result'][0]['meta']
            price = meta.get('regularMarketPrice')
            prev  = meta.get('previousClose') or price
            if price:
                return {
                    'price':    price,
                    'prev':     prev,
                    'day_chg':  price - prev,
                    'day_pct':  (price - prev) / prev * 100 if prev else 0,
                    'currency': meta.get('currency', 'USD'),
                }
        except Exception as e:
            continue
    return None


def fetch_rate() -> float | None:
    """USD/KRW 환율 조회"""
    url = 'https://api.exchangerate-api.com/v4/latest/USD'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read())['rates']['KRW']
    except Exception:
        return None


# ── 맥 알림 ───────────────────────────────────────────────────
def notify(title: str, body: str):
    if not NOTIFY:
        return
    script = f'display notification "{body}" with title "{title}" sound name "Ping"'
    subprocess.run(['osascript', '-e', script], capture_output=True)
    if DASHBOARD_URL:
        subprocess.run(['open', DASHBOARD_URL], capture_output=True)


# ── 메인 ──────────────────────────────────────────────────────
def main():
    if not PORTFOLIO_FILE.exists():
        print(f'❌ {PORTFOLIO_FILE} 없음')
        print('  → 웹 대시보드 설정 탭에서 "데이터 내보내기" 후 portfolio.json으로 저장하세요')
        sys.exit(1)

    data     = json.loads(PORTFOLIO_FILE.read_text(encoding='utf-8'))
    etfs     = data.get('etfs', [])
    cached_rate = data.get('rate', 1380)

    if not etfs:
        print('포트폴리오가 비어 있습니다')
        return

    now = datetime.now()
    bar = '─' * 52
    print(f'\n📊 ETF 포트폴리오 — {now.strftime("%Y-%m-%d %H:%M")}')
    print(bar)

    # 환율
    rate = fetch_rate() or cached_rate
    print(f'USD/KRW: ₩{rate:,.0f}')
    print(bar)

    # ETF별 계산
    total_val  = 0.0
    total_cost = 0.0
    day_change = 0.0
    results    = []

    for etf in etfs:
        ticker  = etf.get('ticker', '')
        name    = etf.get('name', ticker)
        qty     = float(etf.get('quantity', 0))
        avg     = float(etf.get('avgPrice', etf.get('avg_price', 0)))
        cur     = etf.get('currency', 'USD')

        if qty == 0 or avg == 0:
            continue

        res = fetch_price(ticker)

        if res:
            p        = res['price']
            to_krw   = rate if cur == 'USD' else 1
            val_nat  = p * qty
            cost_nat = avg * qty
            val_krw  = val_nat  * to_krw
            cost_krw = cost_nat * to_krw
            day_krw  = res['day_chg'] * qty * to_krw
            pnl_pct  = (val_nat - cost_nat) / cost_nat * 100

            total_val  += val_krw
            total_cost += cost_krw
            day_change += day_krw

            sign     = '+' if pnl_pct  >= 0 else ''
            day_sign = '+' if res['day_pct'] >= 0 else ''
            p_str    = f'₩{p:,.0f}' if cur == 'KRW' else f'${p:.2f}'

            print(f'{ticker:<14} {name[:16]:<16}')
            print(f'  현재가: {p_str:<12} 당일: {day_sign}{res["day_pct"]:+.2f}%   수익률: {sign}{pnl_pct:.2f}%')

            results.append({
                'ticker': ticker, 'name': name,
                'price': p, 'pnl_pct': pnl_pct, 'day_pct': res['day_pct'],
                'val_krw': val_krw, 'ok': True
            })
            # 최신 가격을 etf 데이터에 반영
            etf['price'] = p
            etf['dayChg'] = res['day_chg']
            etf['dayPct'] = res['day_pct']
            etf['_src'] = 'api'
        else:
            print(f'{ticker:<14} {name[:16]:<16}  ❌ 조회 실패')
            results.append({'ticker': ticker, 'name': name, 'ok': False})

    # 전체 요약
    total_pnl     = total_val - total_cost
    total_pnl_pct = total_pnl / total_cost * 100 if total_cost else 0
    base_val      = total_val - day_change
    day_pct_total = day_change / base_val * 100 if base_val > 0 else 0

    day_sign   = '+' if day_change    >= 0 else ''
    total_sign = '+' if total_pnl_pct >= 0 else ''

    print(bar)
    print(f'총 자산  ₩{total_val:>14,.0f}')
    print(f'당일 손익  {day_sign}₩{abs(day_change):>12,.0f}  ({day_sign}{day_pct_total:.2f}%)')
    print(f'총 손익   {total_sign}₩{abs(total_pnl):>12,.0f}  ({total_sign}{total_pnl_pct:.2f}%)')
    print(bar)

    # 맥 알림
    notif_body = (
        f'당일 {day_sign}₩{abs(day_change):,.0f} ({day_sign}{day_pct_total:.2f}%) | '
        f'총 {total_sign}₩{abs(total_pnl):,.0f} ({total_sign}{total_pnl_pct:.2f}%)'
    )
    notify(f'📊 ETF 포트폴리오 — {now.strftime("%m/%d")}', notif_body)

    # portfolio.json 업데이트 (최신 종가 반영)
    data['rate']    = rate
    data['updated'] = now.isoformat()
    PORTFOLIO_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8'
    )
    print(f'✅ portfolio.json 업데이트 완료')


if __name__ == '__main__':
    main()
