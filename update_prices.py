"""
GitHub Actions에서 매일 18:00 KST (09:00 UTC)에 실행되는 가격 업데이트 스크립트.
tickers.json에 있는 종목의 종가를 Yahoo Finance에서 가져와 prices.json에 저장합니다.
"""
import json
import urllib.request
import urllib.error
from datetime import datetime, timezone

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
}

def fetch_price(ticker):
    url = (
        f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}'
        f'?range=1d&interval=1d'
    )
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            result = data.get('chart', {}).get('result', [])
            if not result:
                return None
            meta = result[0].get('meta', {})
            p = meta.get('regularMarketPrice')
            if not p:
                return None
            prev = meta.get('previousClose', p)
            return {
                'price': round(p, 4),
                'dayChg': round(p - prev, 4),
                'dayPct': round((p - prev) / prev * 100, 4),
                'currency': meta.get('currency', 'KRW'),
                'fetchedAt': datetime.now(timezone.utc).isoformat(),
            }
    except Exception as e:
        print(f'  ✗ {ticker}: {e}')
        return None

# tickers.json 읽기
try:
    with open('tickers.json', encoding='utf-8') as f:
        tickers = json.load(f)
except FileNotFoundError:
    print('tickers.json 파일이 없습니다. 빈 파일로 생성합니다.')
    tickers = []
    with open('tickers.json', 'w') as f:
        json.dump([], f)

print(f'종목 수: {len(tickers)}개')

prices = {}
for ticker in tickers:
    print(f'  조회 중: {ticker}')
    result = fetch_price(ticker)
    if result:
        prices[ticker] = result
        print(f'  ✓ {ticker}: {result["price"]} {result["currency"]}')

# 벤치마크 (KOSPI, S&P500) 항상 포함
for bm in ['^KS11', '^GSPC']:
    if bm not in prices:
        result = fetch_price(bm)
        if result:
            prices[bm] = result
            print(f'  ✓ {bm}: {result["price"]}')

output = {
    'updatedAt': datetime.now(timezone.utc).isoformat(),
    'prices': prices,
}

with open('prices.json', 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print(f'\n완료: {len(prices)}/{len(tickers)}개 종목 업데이트 → prices.json 저장')
