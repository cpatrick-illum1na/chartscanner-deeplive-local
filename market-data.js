'use strict';

// Starter watchlist. Stock search is restricted to NYSE/Nasdaq equities; crypto remains searchable and supported.
const SYMBOLS = Object.freeze({
  AAPL: { yahoo: 'AAPL', display: 'Apple Inc.', exchange: 'NASDAQ', quoteType: 'EQUITY' },
  MSFT: { yahoo: 'MSFT', display: 'Microsoft Corporation', exchange: 'NASDAQ', quoteType: 'EQUITY' },
  NVDA: { yahoo: 'NVDA', display: 'NVIDIA Corporation', exchange: 'NASDAQ', quoteType: 'EQUITY' },
  AMZN: { yahoo: 'AMZN', display: 'Amazon.com, Inc.', exchange: 'NASDAQ', quoteType: 'EQUITY' },
  GOOGL: { yahoo: 'GOOGL', display: 'Alphabet Inc.', exchange: 'NASDAQ', quoteType: 'EQUITY' },
  META: { yahoo: 'META', display: 'Meta Platforms, Inc.', exchange: 'NASDAQ', quoteType: 'EQUITY' },
  TSLA: { yahoo: 'TSLA', display: 'Tesla, Inc.', exchange: 'NASDAQ', quoteType: 'EQUITY' },
  IBM: { yahoo: 'IBM', display: 'International Business Machines Corporation', exchange: 'NYSE', quoteType: 'EQUITY' },
  JPM: { yahoo: 'JPM', display: 'JPMorgan Chase & Co.', exchange: 'NYSE', quoteType: 'EQUITY' },
  // QQQ is retained as a requested Nasdaq-listed ETF.
  QQQ: { yahoo: 'QQQ', display: 'Invesco QQQ Trust', exchange: 'NASDAQ', quoteType: 'ETF' },
  // Keep the original crypto instruments available in the starter list.
  BTCUSD: { yahoo: 'BTC-USD', display: 'Bitcoin / U.S. Dollar', exchange: 'CRYPTO', quoteType: 'CRYPTOCURRENCY' },
  ETHUSD: { yahoo: 'ETH-USD', display: 'Ethereum / U.S. Dollar', exchange: 'CRYPTO', quoteType: 'CRYPTOCURRENCY' }
});

const INTERVALS = Object.freeze(new Set(['1m', '5m', '15m', '1h', '1d']));
const NASDAQ_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NASDAQ', 'NASDAQGS', 'NASDAQGM', 'NASDAQCM']);
const NYSE_EXCHANGES = new Set(['NYQ', 'NYSE']);
const SUPPORTED_EXCHANGES = new Set([...NASDAQ_EXCHANGES, ...NYSE_EXCHANGES]);
const CRYPTO_EXCHANGES = new Set(['CCC', 'CRYPTO', 'CRYPTOCURRENCY']);

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function isValidTicker(value) {
  return typeof value === 'string' && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(value);
}

function exchangeGroup(quote = {}) {
  const candidates = [quote.exchange, quote.exchDisp, quote.fullExchangeName]
    .filter(Boolean)
    .map(value => String(value).trim().toUpperCase().replace(/\s+/g, ''));
  if (candidates.some(value => NASDAQ_EXCHANGES.has(value))) return 'NASDAQ';
  if (candidates.some(value => NYSE_EXCHANGES.has(value))) return 'NYSE';
  return null;
}

function isSupportedEquityQuote(quote = {}) {
  if (quote.quoteType !== 'EQUITY') return false;
  if (!isValidTicker(String(quote.symbol || '').toUpperCase())) return false;
  return SUPPORTED_EXCHANGES.has(String(quote.exchange || '').toUpperCase()) || !!exchangeGroup(quote);
}

function isSupportedCryptoQuote(quote = {}) {
  if (quote.quoteType !== 'CRYPTOCURRENCY') return false;
  if (!isValidTicker(String(quote.symbol || '').toUpperCase())) return false;
  const exchange = String(quote.exchange || '').trim().toUpperCase();
  const display = String(quote.exchDisp || quote.fullExchangeName || '').trim().toUpperCase();
  return CRYPTO_EXCHANGES.has(exchange) || CRYPTO_EXCHANGES.has(display);
}

function dashboardSymbol(providerSymbol) {
  const match = Object.entries(SYMBOLS).find(([, item]) => item.yahoo === providerSymbol);
  return match ? match[0] : providerSymbol;
}

function normalizeYahooSearch(payload) {
  const quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
  const seen = new Set();
  return quotes.filter(quote => isSupportedEquityQuote(quote) || isSupportedCryptoQuote(quote)).map(quote => {
    const providerSymbol = String(quote.symbol).toUpperCase();
    const assetClass = quote.quoteType === 'CRYPTOCURRENCY' ? 'CRYPTO' : 'STOCK';
    return {
      symbol: dashboardSymbol(providerSymbol),
      providerSymbol,
      name: quote.longname || quote.shortname || providerSymbol,
      exchange: assetClass === 'CRYPTO' ? 'CRYPTO' : exchangeGroup(quote),
      exchangeCode: quote.exchange || null,
      quoteType: quote.quoteType,
      assetClass
    };
  }).filter(item => {
    if (seen.has(item.symbol)) return false;
    seen.add(item.symbol);
    return true;
  });
}

function normalizeYahooChart(alias, interval, payload, providerSymbol = alias) {
  const chart = payload && payload.chart;
  if (!chart) throw new Error('Yahoo Finance returned an invalid chart response.');
  if (chart.error) {
    const description = chart.error.description || chart.error.code || 'Unknown provider error';
    throw new Error(`Yahoo Finance: ${description}`);
  }
  const result = chart.result && chart.result[0];
  if (!result) throw new Error('Yahoo Finance returned no chart data for this symbol.');

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] || {};
  const bars = timestamps.map((timestamp, index) => {
    const open = finiteOrNull(quote.open?.[index]);
    const high = finiteOrNull(quote.high?.[index]);
    const low = finiteOrNull(quote.low?.[index]);
    const close = finiteOrNull(quote.close?.[index]);
    if (![open, high, low, close].every(value => Number.isFinite(value) && value > 0)) return null;
    return {
      time: Number(timestamp),
      open,
      high,
      low,
      close,
      volume: finiteOrNull(quote.volume?.[index]) ?? 0
    };
  }).filter(Boolean);

  if (!bars.length) throw new Error('Yahoo Finance returned no usable OHLCV bars for this interval.');

  const meta = result.meta || {};
  const previousClose = finiteOrNull(meta.chartPreviousClose ?? meta.previousClose);
  const latestClose = bars[bars.length - 1].close;
  const currentPrice = finiteOrNull(meta.regularMarketPrice) ?? latestClose;
  const changePercent = previousClose && previousClose > 0
    ? ((currentPrice - previousClose) / previousClose) * 100
    : null;

  return {
    symbol: alias,
    providerSymbol,
    provider: 'Yahoo Finance (unofficial public chart endpoint)',
    interval,
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    timezone: meta.exchangeTimezoneName || meta.timezone || 'UTC',
    previousClose,
    currentPrice,
    changePercent,
    dayHigh: finiteOrNull(meta.regularMarketDayHigh),
    dayLow: finiteOrNull(meta.regularMarketDayLow),
    dayVolume: finiteOrNull(meta.regularMarketVolume),
    regularMarketTime: finiteOrNull(meta.regularMarketTime),
    bars
  };
}

module.exports = {
  SYMBOLS,
  INTERVALS,
  NASDAQ_EXCHANGES,
  NYSE_EXCHANGES,
  SUPPORTED_EXCHANGES,
  CRYPTO_EXCHANGES,
  isValidTicker,
  exchangeGroup,
  isSupportedEquityQuote,
  isSupportedCryptoQuote,
  normalizeYahooSearch,
  normalizeYahooChart
};
