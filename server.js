'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { SYMBOLS, INTERVALS, isValidTicker, normalizeYahooSearch, normalizeYahooChart } = require('./market-data');
const { DEFAULT_BASE_URL: LM_DEFAULT_BASE_URL, listModels: listLmModels, testConnection: testLmConnection, analyzeMarket: analyzeWithLmStudio } = require('./lm-studio');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const CACHE_TTL_MS = 10_000;
const STALE_TTL_MS = 5 * 60_000;
const cache = new Map();
const inflight = new Map();
const SEARCH_CACHE_TTL_MS = 60_000;
const searchCache = new Map();
const searchInflight = new Map();
const authorizedSymbols = new Map();

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'null'
  });
  res.end(body);
}

async function fetchYahoo(symbol, interval) {
  const providerSymbol = SYMBOLS[symbol]?.yahoo || symbol;
  const range = interval === '1d' ? '1mo' : (interval === '1m' ? '1d' : '5d');
  const params = new URLSearchParams({ range, interval, includePrePost: 'false', events: 'div,splits' });
  const encodedSymbol = encodeURIComponent(providerSymbol);
  const errors = [];

  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const endpoint = `https://${host}/v8/finance/chart/${encodedSymbol}?${params.toString()}`;
    try {
      const response = await fetch(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${host}`);
      const payload = await response.json();
      const normalized = normalizeYahooChart(symbol, interval, payload, providerSymbol);
      return { ...normalized, fetchedAt: new Date().toISOString(), stale: false };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  throw new Error(errors.join(' | ') || 'Yahoo Finance request failed.');
}

async function fetchYahooAssetSearch(query) {
  const params = new URLSearchParams({
    q: query,
    region: 'US',
    lang: 'en-US',
    quotesCount: '40',
    newsCount: '0',
    enableFuzzyQuery: 'false'
  });
  const errors = [];
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const response = await fetch(`https://${host}/v1/finance/search?${params.toString()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${host}`);
      const quotes = normalizeYahooSearch(await response.json());
      const results = quotes.slice(0, 25);
      const now = Date.now();
      for (const asset of results) authorizedSymbols.set(asset.symbol, now);
      return { query, results, fetchedAt: new Date().toISOString(), filter: 'NYSE/Nasdaq common stocks plus cryptocurrencies' };
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }
  throw new Error(errors.join(' | ') || 'Yahoo Finance asset search failed.');
}

async function searchAssets(query) {
  const key = query.toLowerCase();
  const now = Date.now();
  const cached = searchCache.get(key);
  if (cached && now - cached.cachedAt < SEARCH_CACHE_TTL_MS) return cached.value;
  if (searchInflight.has(key)) return searchInflight.get(key);
  const request = (async () => {
    try {
      const value = await fetchYahooAssetSearch(query);
      searchCache.set(key, { value, cachedAt: Date.now() });
      return value;
    } finally {
      searchInflight.delete(key);
    }
  })();
  searchInflight.set(key, request);
  return request;
}

async function getMarketData(symbol, interval, force = false) {
  const key = `${symbol}:${interval}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (!force && cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.value;
  if (inflight.has(key)) return inflight.get(key);

  const request = (async () => {
    try {
      const value = await fetchYahoo(symbol, interval);
      cache.set(key, { value, cachedAt: Date.now() });
      return value;
    } catch (error) {
      const lastGood = cache.get(key);
      if (lastGood && Date.now() - lastGood.cachedAt <= STALE_TTL_MS) {
        return {
          ...lastGood.value,
          stale: true,
          staleReason: error.message,
          cachedAt: new Date(lastGood.cachedAt).toISOString()
        };
      }
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, request);
  return request;
}


async function readJsonBody(req, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Request body exceeds the ${maxBytes} byte limit.`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object.');
    return parsed;
  } catch (error) {
    if (error.message === 'JSON body must be an object.') throw error;
    throw new Error('Request body must contain valid JSON.');
  }
}

function serveStatic(req, res, pathname) {
  let requestPath = pathname;
  if (requestPath === '/') requestPath = '/index.html';
  const filePath = path.resolve(root, `.${requestPath}`);
  if (!filePath.startsWith(root + path.sep) && filePath !== path.join(root, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (parsed.pathname.startsWith('/api/lmstudio/')) {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed');
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    try {
      if (parsed.pathname === '/api/lmstudio/models') {
        const result = await listLmModels(body.baseUrl || LM_DEFAULT_BASE_URL);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (parsed.pathname === '/api/lmstudio/test') {
        const result = await testLmConnection(body.baseUrl || LM_DEFAULT_BASE_URL, body.model);
        sendJson(res, 200, result);
        return;
      }
      if (parsed.pathname === '/api/lmstudio/analyze') {
        const result = await analyzeWithLmStudio(body.baseUrl || LM_DEFAULT_BASE_URL, body.model, body.snapshot);
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 404, { error: 'Unknown LM Studio API endpoint.' });
    } catch (error) {
      const isInputError = /^(Enter |For local safety|The LM Studio URL|The request body|Request body|JSON body|No chart snapshot|The chart snapshot|At least |The model identifier|Model [“\"])/i.test(error.message);
      sendJson(res, isInputError ? 400 : 502, {
        error: 'LM Studio request failed.',
        detail: error.message
      });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  if (parsed.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      provider: 'Yahoo Finance (unofficial public chart endpoint)',
      starterWatchlist: Object.keys(SYMBOLS),
      searchableStockExchanges: ['NYSE', 'NASDAQ'],
      searchableStockQuoteType: 'EQUITY',
      searchableCryptoQuoteType: 'CRYPTOCURRENCY',
      supportedIntervals: [...INTERVALS],
      lmStudio: { supported: true, defaultBaseUrl: LM_DEFAULT_BASE_URL, api: 'OpenAI-compatible /v1/models; native /api/v1/chat preferred, OpenAI-compatible chat completions fallback' },
      pollHintSeconds: 15
    });
    return;
  }

  if (parsed.pathname === '/api/search') {
    const query = String(parsed.searchParams.get('q') || '').trim().slice(0, 80);
    if (query.length < 1) {
      sendJson(res, 200, { query, results: [], filter: 'NYSE/Nasdaq common stocks plus cryptocurrencies' });
      return;
    }
    try {
      const data = await searchAssets(query);
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 502, {
        error: 'Could not search NYSE / Nasdaq stocks and cryptocurrencies through Yahoo Finance.',
        detail: error.message,
        query
      });
    }
    return;
  }

  if (parsed.pathname === '/api/market') {
    const symbol = String(parsed.searchParams.get('symbol') || '').trim().toUpperCase();
    const interval = String(parsed.searchParams.get('interval') || '5m').toLowerCase();
    if (!isValidTicker(symbol)) {
      sendJson(res, 400, { error: 'Invalid ticker symbol.' });
      return;
    }
    const isStarter = Object.hasOwn(SYMBOLS, symbol);
    if (!isStarter && !authorizedSymbols.has(symbol)) {
      sendJson(res, 403, { error: 'Search for this stock or cryptocurrency before requesting its chart.' });
      return;
    }
    if (!INTERVALS.has(interval)) {
      sendJson(res, 400, { error: `Unsupported interval. Supported: ${[...INTERVALS].join(', ')}` });
      return;
    }
    try {
      const data = await getMarketData(symbol, interval, parsed.searchParams.get('refresh') === '1');
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, 502, {
        error: 'Could not retrieve market data from Yahoo Finance.',
        detail: error.message,
        symbol,
        providerSymbol: SYMBOLS[symbol]?.yahoo || symbol,
        interval
      });
    }
    return;
  }

  serveStatic(req, res, parsed.pathname);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`DeepLive local dashboard running at http://localhost:${port}`);
  console.log('Market data: Yahoo Finance public chart endpoint (unofficial; may be delayed or rate-limited).');
  console.log('Press Ctrl+C to stop.');
});
