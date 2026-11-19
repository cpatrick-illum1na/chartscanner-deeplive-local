'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SYMBOLS, INTERVALS, isValidTicker, normalizeYahooSearch, normalizeYahooChart } = require('./market-data');

const fixture = {
  chart: {
    result: [{
      meta: {
        currency: 'USD',
        exchangeName: 'NMS',
        fullExchangeName: 'NasdaqGS',
        exchangeTimezoneName: 'America/New_York',
        chartPreviousClose: 500,
        regularMarketPrice: 502.5,
        regularMarketDayHigh: 504,
        regularMarketDayLow: 498,
        regularMarketVolume: 123456
      },
      timestamp: [1795103100, 1795103400, 1795103700],
      indicators: { quote: [{
        open: [500, 501, 502],
        high: [501, 503, 503],
        low: [499, 500, 501],
        close: [500.5, 502, 502.5],
        volume: [1000, 1200, 900]
      }] }
    }],
    error: null
  }
};

test('QQQ and the original crypto assets are in the public Yahoo symbol map', () => {
  assert.equal(SYMBOLS.QQQ.yahoo, 'QQQ');
  assert.equal(SYMBOLS.BTCUSD.yahoo, 'BTC-USD');
  assert.equal(SYMBOLS.ETHUSD.yahoo, 'ETH-USD');
  assert.equal(INTERVALS.has('5m'), true);
});

test('normalizes OHLCV bars and quote metadata', () => {
  const result = normalizeYahooChart('QQQ', '5m', fixture);
  assert.equal(result.providerSymbol, 'QQQ');
  assert.equal(result.bars.length, 3);
  assert.deepEqual(result.bars[2], {
    time: 1795103700, open: 502, high: 503, low: 501, close: 502.5, volume: 900
  });
  assert.equal(result.currentPrice, 502.5);
  assert.equal(result.changePercent, 0.5);
  assert.equal(result.exchange, 'NasdaqGS');
  assert.equal(result.timezone, 'America/New_York');
});

test('drops incomplete provider slots and errors when no usable bars exist', () => {
  const broken = structuredClone(fixture);
  broken.chart.result[0].indicators.quote[0].close = [null, null, null];
  assert.throws(() => normalizeYahooChart('QQQ', '5m', broken), /no usable OHLCV bars/);
});

test('surfaces provider-reported symbol errors', () => {
  assert.throws(() => normalizeYahooChart('QQQ', '5m', { chart: { result: null, error: { description: 'Not found' } } }), /Not found/);
});


test('stock search keeps only NYSE and Nasdaq common equities', () => {
  const results = normalizeYahooSearch({
    quotes: [
      { symbol: 'AAPL', shortname: 'Apple Inc.', quoteType: 'EQUITY', exchange: 'NMS', exchDisp: 'NASDAQ' },
      { symbol: 'IBM', longname: 'International Business Machines', quoteType: 'EQUITY', exchange: 'NYQ', exchDisp: 'NYSE' },
      { symbol: 'BRK-B', shortname: 'Berkshire Hathaway', quoteType: 'EQUITY', exchange: 'NYQ', exchDisp: 'NYSE' },
      { symbol: 'QQQ', shortname: 'Invesco QQQ Trust', quoteType: 'ETF', exchange: 'NMS', exchDisp: 'NASDAQ' },
      { symbol: 'SPY', shortname: 'SPDR S&P 500 ETF', quoteType: 'ETF', exchange: 'PCX', exchDisp: 'NYSE Arca' },
      { symbol: 'XYZ', shortname: 'OTC issuer', quoteType: 'EQUITY', exchange: 'PNK', exchDisp: 'OTC Markets' },
      { symbol: '^GSPC', shortname: 'S&P 500', quoteType: 'INDEX', exchange: 'SNP', exchDisp: 'SNP' },
      { symbol: 'VOD.L', shortname: 'Vodafone', quoteType: 'EQUITY', exchange: 'LSE', exchDisp: 'London' }
    ]
  });

  assert.deepEqual(results.map(item => item.symbol), ['AAPL', 'IBM', 'BRK-B']);
  assert.equal(results[0].exchange, 'NASDAQ');
  assert.equal(results[1].exchange, 'NYSE');
  assert.equal(results[0].name, 'Apple Inc.');
});

test('stock exchange restrictions do not remove cryptocurrency search results', () => {
  const results = normalizeYahooSearch({
    quotes: [
      { symbol: 'AAPL', shortname: 'Apple Inc.', quoteType: 'EQUITY', exchange: 'NMS', exchDisp: 'NASDAQ' },
      { symbol: 'IBM', shortname: 'IBM', quoteType: 'EQUITY', exchange: 'NYQ', exchDisp: 'NYSE' },
      { symbol: 'XYZ', shortname: 'OTC issuer', quoteType: 'EQUITY', exchange: 'PNK', exchDisp: 'OTC Markets' },
      { symbol: 'BTC-USD', shortname: 'Bitcoin USD', quoteType: 'CRYPTOCURRENCY', exchange: 'CCC', exchDisp: 'CCC' },
      { symbol: 'ETH-USD', shortname: 'Ethereum USD', quoteType: 'CRYPTOCURRENCY', exchange: 'CCC', exchDisp: 'CCC' },
      { symbol: 'DOGE-USD', shortname: 'Dogecoin USD', quoteType: 'CRYPTOCURRENCY', exchange: 'CCC', exchDisp: 'CCC' },
      { symbol: 'EURUSD=X', shortname: 'Euro USD', quoteType: 'CURRENCY', exchange: 'CCY', exchDisp: 'CCY' },
      { symbol: '^GSPC', shortname: 'S&P 500', quoteType: 'INDEX', exchange: 'SNP', exchDisp: 'SNP' }
    ]
  });

  assert.deepEqual(results.map(item => item.symbol), ['AAPL', 'IBM', 'BTCUSD', 'ETHUSD', 'DOGE-USD']);
  assert.deepEqual(results.slice(2).map(item => item.assetClass), ['CRYPTO', 'CRYPTO', 'CRYPTO']);
  assert.equal(results[2].providerSymbol, 'BTC-USD');
  assert.equal(results[2].exchange, 'CRYPTO');
});

test('ticker validation permits common US ticker punctuation but blocks path-like input', () => {
  assert.equal(isValidTicker('AAPL'), true);
  assert.equal(isValidTicker('BRK-B'), true);
  assert.equal(isValidTicker('BRK.B'), true);
  assert.equal(isValidTicker('../AAPL'), false);
  assert.equal(isValidTicker('^GSPC'), false);
  assert.equal(isValidTicker(''), false);
});

test('dynamic stock tickers normalize through the chart response adapter', () => {
  const result = normalizeYahooChart('IBM', '5m', fixture);
  assert.equal(result.symbol, 'IBM');
  assert.equal(result.providerSymbol, 'IBM');
  assert.equal(result.bars.length, 3);
});

test('crypto aliases retain the dashboard symbol and report the Yahoo provider symbol', () => {
  const result = normalizeYahooChart('BTCUSD', '5m', fixture, SYMBOLS.BTCUSD.yahoo);
  assert.equal(result.symbol, 'BTCUSD');
  assert.equal(result.providerSymbol, 'BTC-USD');
  assert.equal(result.bars.length, 3);
});
