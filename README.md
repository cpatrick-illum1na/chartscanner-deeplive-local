# ChartScanner DeepLive 1.6 — Local Yahoo Market Data + LM Studio Analysis

A local, self-hosted DeepLive-style dashboard. Search NYSE- or Nasdaq-listed common stocks and cryptocurrencies, load OHLCV bars through a Node.js server-side proxy, and optionally send the current chart snapshot to a local LM Studio model for a structured market interpretation. The exchange restriction applies only to stocks; crypto is not filtered by stock exchanges.

## Run on Windows

1. Install **Node.js 18 or newer**.
2. Extract the ZIP.
3. Open PowerShell in the extracted folder.
4. Run:

```powershell
.\Start-DeepLive.ps1
```

Or run:

```powershell
npm start
```

Open <http://localhost:4173>.

Node.js is required. `python -m http.server` is no longer a supported launch method because it does not provide the local `/api/market` data proxy.


## Search stocks and crypto

Use the scanner search box to look up a stock ticker or company name (for example `AAPL`, `Microsoft`, or `Berkshire Hathaway`) or a cryptocurrency (for example `Bitcoin`, `BTC-USD`, `Ethereum`, or `ETH-USD`). The local server calls Yahoo Finance's public search endpoint. Stock results are accepted only when Yahoo classifies them as `EQUITY` and identifies their listing exchange as NYSE or Nasdaq. Crypto results are accepted when Yahoo classifies them as `CRYPTOCURRENCY`; crypto does not need to be listed on a stock exchange. OTC, foreign-listed stocks, indexes, mutual funds, and unsupported security types remain excluded.

Select a result to add it to the current in-memory watchlist and load its chart. Search is available through `GET /api/search?q=...`. The chart proxy accepts starter watchlist symbols or symbols returned by the search endpoint; a non-watchlist ticker must be searched before a chart request is accepted. Newly selected assets remain in the watchlist for the current browser session; the starter watchlist is restored after a page reload.

The starter list contains AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, IBM, JPM, QQQ, BTCUSD, and ETHUSD. QQQ is retained as a requested Nasdaq-listed ETF. BTCUSD and ETHUSD are the original crypto instruments, mapped to Yahoo Finance symbols `BTC-USD` and `ETH-USD`.

## Live market data

The local server requests Yahoo Finance's public chart endpoint:

```text
https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=5d&interval=5m
```

It normalizes and serves OHLCV bars at `/api/market`. The dashboard polls the selected instrument approximately every 15 seconds. Yahoo Finance may return delayed data; this is polling, not a streaming WebSocket feed. The provider endpoint is unofficial/undocumented, may throttle requests, and may change without notice. No API key is required at the time this version was built.

### Starter watchlist and provider symbols

| Dashboard symbol | Yahoo Finance symbol | Security type | Listing |
|---|---|---|---|
| AAPL | `AAPL` | Common stock | Nasdaq |
| MSFT | `MSFT` | Common stock | Nasdaq |
| NVDA | `NVDA` | Common stock | Nasdaq |
| AMZN | `AMZN` | Common stock | Nasdaq |
| GOOGL | `GOOGL` | Common stock | Nasdaq |
| META | `META` | Common stock | Nasdaq |
| TSLA | `TSLA` | Common stock | Nasdaq |
| IBM | `IBM` | Common stock | NYSE |
| JPM | `JPM` | Common stock | NYSE |
| QQQ | `QQQ` | ETF (explicitly retained) | Nasdaq |
| BTCUSD | `BTC-USD` | Cryptocurrency | Crypto |
| ETHUSD | `ETH-USD` | Cryptocurrency | Crypto |

Dynamic search can add any common stock returned by Yahoo's search endpoint that passes the server-side NYSE / Nasdaq filter, plus any returned cryptocurrency classified as `CRYPTOCURRENCY`. The default chart interval is 5m. Other supported chart intervals are 1m, 15m, 1h, 4h (aggregated from 1h bars), and 1D.

## LM Studio local model integration

The dashboard can use a model served by LM Studio. The local Node server makes the model request, so the browser does not need direct CORS access to LM Studio. DeepLive prefers LM Studio native REST API `POST /api/v1/chat` (LM Studio 0.4.0 or newer), then falls back to OpenAI-compatible `POST /v1/chat/completions` if the native route is unavailable.

### 1. Start LM Studio

1. Open LM Studio and load the model you want to use in the Chat or Developer view.
2. Open the **Developer** tab and start the local server.
3. Leave the default server port at `1234` unless you intentionally changed it.
4. The default OpenAI-compatible base URL is:

```text
http://127.0.0.1:1234/v1
```

DeepLive uses `GET /v1/models` to discover the exact model IDs. For chat, it now prefers LM Studio's native `POST /api/v1/chat` REST endpoint, which supports an explicit `reasoning` setting. This is important for reasoning models such as Qwen3.5. On current LM Studio versions, this native endpoint is preferred; older versions fall back to `POST /v1/chat/completions`. See the [LM Studio REST API overview](https://lmstudio.ai/docs/developer/rest), [native chat endpoint](https://lmstudio.ai/docs/developer/rest/chat), and [OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat).

### 2. Configure DeepLive

1. Start this dashboard and open **Settings** in the top-right of the page.
2. Set the Base URL. The default is `http://127.0.0.1:1234/v1`.
3. Click **Load models**, then choose the model ID from the suggestions. You can also type the model ID manually.
4. Click **Test connection**. This verifies model discovery and sends a short native REST chat test with reasoning disabled. It no longer uses the 30-token OpenAI-compatible completion that caused the Qwen3.5 empty-response issue.
5. Enable **Use LM Studio for the overall market interpretation** and click **Save settings**.
6. Click **Run analysis** to refresh market data and send the chart snapshot to LM Studio.

Settings are saved in this browser's local storage. The model and base URL are not sent to a cloud service by this integration.


### Qwen3.5 / empty response troubleshooting

The November 19, 2026 Qwen3.5-9B server log showed that this model accepts only `reasoning: "off"` or `reasoning: "on"`; it rejects `reasoning: "low"`. The earlier retry then omitted the setting, allowing reasoning to consume all 3,072 output tokens without a final message. DeepLive 1.6 now sends `reasoning: "off"` for both connection tests and chart analysis, limits the requested analysis answer to a compact JSON payload, and retries an unsupported level with explicit `"off"` before considering omission. A response that contains reasoning but no final message is treated as an error, never as a trading decision.

The earlier connector sent a 30-token `max_tokens` connection test to `/v1/chat/completions`. Some reasoning models, including Qwen3.5-9B, can spend that entire budget in `reasoning_content`, leaving `message.content` empty with `finish_reason: "length"`. This is token-budget exhaustion, not proof that the model lacks chat-completion support.

The updated connector addresses this by using the native LM Studio REST chat endpoint: connection tests and chart analysis both request `reasoning: "off"`, which is supported by Qwen3.5-9B. The analysis budget is 1,400 output tokens and the prompt requires compact JSON rather than a long internal monologue. If a model rejects a requested reasoning level, DeepLive retries explicitly with `"off"`; it omits the parameter only if the model also rejects `"off"`. Only final message content is parsed; reasoning-only output is never treated as a prediction.

Use LM Studio 0.4.0 or newer to use the preferred native endpoint. On an older release, DeepLive falls back to the OpenAI-compatible chat endpoint; reasoning models may still have template-specific limitations on that older path. If the issue persists, update LM Studio, restart its local server, reload `qwen/qwen3.5-9b`, then click **Load models** and **Test connection** again.

### 3. What the model receives

For the selected symbol and timeframe, the local server sends up to 40 recent OHLCV candles, the current quote metadata, and local indicator values including EMA 9/21, EMA 12/26, RSI(14), six-bar momentum, ATR/range, 20-bar high/low position, and the weighted local indicator score/signal.

The model returns a structured `BUY`, `SELL`, or `WAIT` assessment with a confidence rating, horizon, summary, reasoning, bullish factors, bearish/conflicting factors, and an invalidation condition. The native LM Studio chat endpoint is used with `reasoning: "off"` for market analysis and a 1,400-token output budget. The prompt requests a compact JSON object and asks the model not to expose a step-by-step internal monologue. The connection test also uses `reasoning: "off"` and 128 output tokens. Its interpretation is displayed in the Parliament verdict area. The three local technical-analysis cards remain visible for comparison.

**Automatic analysis is optional and off by default.** Enable **Automatically re-analyze after new chart bars load** if you want to run the model after each market-data refresh. The dashboard polls about every 15 seconds. Market-data polling continues while the model works; only one model request runs at a time. If new bars arrive during inference, the older result is discarded, and auto mode queues an interpretation of the latest snapshot.

### Important LM Studio notes

- Load the selected model in LM Studio before testing. The model identifier must match an ID returned by `/v1/models`.
- The default URL assumes LM Studio is running on the same computer as this dashboard. For safety, the local server only accepts loopback base URLs (`localhost`, `127.0.0.1`, or `::1`); remote/LAN model servers are intentionally not accepted.
- No API key is required for a standard local LM Studio server. If LM Studio has authentication enabled, this version does not yet expose an API-token setting.
- If JSON response mode is unsupported by the loaded model/runtime, the connector retries without JSON mode and validates the returned JSON itself.
- Reasoning models can put tokens in a separate `reasoning_content` channel. Older integrations that set a tiny `max_tokens` value on `/v1/chat/completions` can exhaust the budget before any final answer appears. DeepLive now prefers `/api/v1/chat`, uses the documented `reasoning` option (`off` for both connection tests and analysis), and uses a sufficient output budget. Older servers use the OpenAI-compatible fallback with a larger token limit and explicit token-exhaustion diagnostics.
- Model output is a second opinion, not a verified forecast. Confidence is the model's confidence in its interpretation, **not** the statistical probability of a profitable trade.
- The model is not fine-tuned or trained by this feature. It interprets the data provided for each request; it does not automatically learn from past outcomes or backtests.
- The model is instructed not to invent news, fundamentals, unprovided indicators, or entry/stop/target prices. Existing illustrative trade levels remain calculated locally.
- If LM Studio is stopped or returns an invalid response, the local technical-indicator verdict remains available.

## What's included

- Dark, responsive DeepLive-style dashboard
- Public Yahoo Finance OHLCV data for the selected symbol
- Actual candles, OHLC readout, session stats, and latest-bar timestamps
- EMA 9 overlay calculated from the downloaded closing prices
- Support/resistance reference levels derived from recent candle ranges
- Search NYSE / Nasdaq common stocks and cryptocurrencies
- Exchange restrictions apply only to stocks; cryptocurrency search remains enabled
- QQQ retained as a clearly labeled Nasdaq-listed ETF
- BTCUSD and ETHUSD restored to the starter watchlist
- Technical consensus calculated locally from EMA trend, RSI, momentum, and 20-bar range position
- Optional LM Studio local model integration with editable base URL/model ID, model discovery, connection test, manual and optional automatic analysis
- Model interpretation uses up to 40 downloaded candles plus local indicators and displays signal, confidence, reasoning, supporting factors, risks, and invalidation
- Local indicator fallback remains active when LM Studio is offline; browser settings persist in local storage
- 15-second polling, pause/resume, manual refresh, instrument search, and chart expansion
- Local API health endpoint: <http://localhost:4173/api/health>

## Important limitations

- Yahoo Finance's chart endpoint is not a documented or licensed real-time market-data API. Availability, delays, symbol coverage, and rate limits are controlled by Yahoo and can change.
- Data is **not guaranteed real-time**. A 15-second polling interval does not make the upstream quotes real-time or exchange-grade.
- The Parliament-style scores are deterministic local technical-indicator calculations. When enabled, LM Studio provides an additional local-model interpretation; neither output is a trading recommendation or guaranteed forecast.
- Volume fields may be absent for some instruments. The dashboard displays `—` when the provider does not return a usable value.
- No broker, order routing, ChartScanner account, or execution functionality is connected.

## Tests

Run the built-in Node.js tests:

```powershell
npm test
```

The tests cover NYSE / Nasdaq stock filtering, cryptocurrency search inclusion, ticker validation, QQQ and crypto provider mappings, dynamic OHLCV normalization, missing candle slots, LM Studio URL restrictions, chart snapshot validation, model JSON parsing, and AI response validation. They do not guarantee Yahoo Finance or LM Studio is reachable from your network.

## Project files

- `index.html` — dashboard structure
- `styles.css` — dashboard styling
- `app.js` — chart drawing, polling, indicators, and interactions
- `server.js` — local static server and Yahoo Finance proxy
- `market-data.js` — supported symbols and provider response normalization
- `lm-studio.js` — loopback-only LM Studio connector, snapshot validation, prompt construction, and response parsing
- `tests-market-data.js` — market-data tests
- `tests-lm-studio.js` — LM Studio connector tests
- `Start-DeepLive.ps1` — Windows launcher
- `package.json` — start/test scripts
