'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBaseUrl,
  nativeApiRoot,
  extractNativeChatContent,
  nativeChat,
  isNativeEndpointUnavailable,
  isUnsupportedReasoningSetting,
  chatCompletion,
  testConnection,
  analyzeMarket,
  sanitizeSnapshot,
  parseJsonContent,
  normalizeAnalysis,
  buildAnalysisMessages
} = require('./lm-studio');

const bars = Array.from({ length: 10 }, (_, index) => ({
  time: 1795103100 + index * 300,
  open: 100 + index * 0.2,
  high: 100.5 + index * 0.2,
  low: 99.8 + index * 0.2,
  close: 100.3 + index * 0.2,
  volume: 1200 + index * 100
}));

const snapshot = {
  symbol: 'AAPL',
  assetName: 'Apple Inc.',
  assetType: 'common stock',
  exchange: 'NASDAQ',
  interval: '5m',
  currency: 'USD',
  fetchedAt: '2026-11-19T16:00:00.000Z',
  stale: false,
  currentPrice: 102.1,
  changePercent: 1.3,
  indicators: {
    ema9: 101.8, ema21: 101.2, ema12: 101.6, ema26: 101.1,
    rsi14: 58, momentum6Bars: 1.1, atr14: 0.7,
    rangeHigh20: 103, rangeLow20: 99, rangePositionPct: 77.5,
    trendScore: 71, patternScore: 65, momentumScore: 68,
    localCombinedScore: 68, localSignal: 'BUY'
  },
  bars
};

test('normalizes common LM Studio base URL forms', () => {
  assert.equal(normalizeBaseUrl('http://localhost:1234'), 'http://localhost:1234/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
});

test('blocks non-loopback LM Studio endpoints', () => {
  assert.throws(() => normalizeBaseUrl('https://localhost:1234/v1'), /http:\/\//);
  assert.throws(() => normalizeBaseUrl('http://192.168.1.20:1234/v1'), /loopback/);
  assert.throws(() => normalizeBaseUrl('http://example.com/v1'), /loopback/);
  assert.throws(() => normalizeBaseUrl('http://user:pass@localhost:1234/v1'), /credentials/);
});

test('sanitizes chart snapshot and keeps only the most recent 40 valid bars', () => {
  const longBars = Array.from({ length: 50 }, (_, index) => ({ ...bars[index % bars.length], time: bars[0].time + index * 300 }));
  const value = { ...snapshot, bars: longBars };
  const result = sanitizeSnapshot(value);
  assert.equal(result.symbol, 'AAPL');
  assert.equal(result.bars.length, 40);
  assert.equal(result.indicators.localSignal, 'BUY');
  assert.equal(result.bars[0].time, longBars[10].time);
});

test('rejects snapshots without enough valid bars and rejects path-like symbols', () => {
  assert.throws(() => sanitizeSnapshot({ ...snapshot, bars: bars.slice(0, 5) }), /At least eight/);
  assert.throws(() => sanitizeSnapshot({ ...snapshot, symbol: '../private' }), /invalid symbol/);
});

test('parses JSON content even when the model wraps it in a markdown fence', () => {
  const parsed = parseJsonContent('```json\n{"signal":"WAIT","confidence":62}\n```');
  assert.equal(parsed.signal, 'WAIT');
  assert.equal(parsed.confidence, 62);
});

test('normalizes structured model analysis and validates signal confidence', () => {
  const result = normalizeAnalysis({
    signal: 'buy', confidence: 73.6, horizon: 'next 3 bars',
    summary: 'Trend supports continuation, but resistance is nearby.',
    reasoning: 'EMA alignment and positive momentum support the move.',
    bullishFactors: ['EMA 9 is above EMA 21'],
    bearishFactors: ['Price is close to recent range high'],
    invalidation: 'A close below EMA 21 weakens the thesis.'
  });
  assert.equal(result.signal, 'BUY');
  assert.equal(result.confidence, 74);
  assert.deepEqual(result.bullishFactors, ['EMA 9 is above EMA 21']);
  assert.throws(() => normalizeAnalysis({ signal: 'MAYBE', confidence: 50 }), /valid signal/);
  assert.throws(() => normalizeAnalysis({ signal: 'BUY', confidence: 150 }), /invalid confidence/);
});

test('builds a system prompt that forbids invented data and price targets', () => {
  const messages = buildAnalysisMessages(sanitizeSnapshot(snapshot));
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /Do not invent news/);
  assert.match(messages[0].content, /Do not produce entry, stop-loss, or target prices/);
  assert.match(messages[1].content, /"symbol":"AAPL"/);
});


test('builds native LM Studio REST API URL from the configured OpenAI-compatible base URL', () => {
  assert.equal(nativeApiRoot('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234');
  assert.equal(nativeApiRoot('http://localhost:4321'), 'http://localhost:4321');
});

test('extracts only final message content from native API output and ignores reasoning items', () => {
  const text = extractNativeChatContent({
    output: [
      { type: 'reasoning', content: 'private model reasoning' },
      { type: 'message', content: '{"signal":"WAIT"}' },
      { type: 'tool_call', tool: 'not-used' },
      { type: 'message', content: ' trailing text ' }
    ]
  });
  assert.equal(text, '{"signal":"WAIT"}\n trailing text');
});

test('detects native endpoint absence for backward-compatible OpenAI API fallback', () => {
  assert.equal(isNativeEndpointUnavailable(new Error('LM Studio returned 404: route not found')), true);
  assert.equal(isNativeEndpointUnavailable(new Error('LM Studio returned 500: model is busy')), false);
});

test('detects unsupported reasoning settings so native chat can retry without that option', () => {
  assert.equal(isUnsupportedReasoningSetting(new Error('Model does not support reasoning')), true);
  assert.equal(isUnsupportedReasoningSetting(new Error('Invalid reasoning setting')), true);
  assert.equal(isUnsupportedReasoningSetting(new Error('Model is busy')), false);
});

test('connection test uses native API with reasoning disabled and a usable output budget', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen/qwen3.5-9b' }] }), { status: 200 });
    }
    if (String(url).endsWith('/api/v1/chat')) {
      return new Response(JSON.stringify({ output: [{ type: 'message', content: 'LM_STUDIO_OK' }], stats: { reasoning_output_tokens: 0 } }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const result = await testConnection('http://127.0.0.1:1234/v1', 'qwen/qwen3.5-9b');
    assert.equal(result.ok, true);
    assert.equal(result.response, 'LM_STUDIO_OK');
    assert.match(result.apiMode, /native/);
    const request = calls.find(call => call.url.endsWith('/api/v1/chat'));
    assert.equal(request.body.reasoning, 'off');
    assert.equal(request.body.max_output_tokens, 128);
    assert.equal(Object.hasOwn(request.body, 'max_tokens'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('connection test falls back to OpenAI-compatible API on older LM Studio servers with a larger token cap', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), { status: 200 });
    }
    if (String(url).endsWith('/api/v1/chat')) {
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
    }
    if (String(url).endsWith('/v1/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'LM_STUDIO_OK' }, finish_reason: 'stop' }] }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const result = await testConnection('http://127.0.0.1:1234/v1', 'test-model');
    assert.equal(result.ok, true);
    assert.match(result.apiMode, /fallback/);
    const request = calls.find(call => call.url.endsWith('/v1/chat/completions'));
    assert.equal(request.body.max_tokens, 512);
  } finally {
    global.fetch = originalFetch;
  }
});

test('market analysis uses Qwen-compatible reasoning OFF and parses returned JSON', async () => {
  const originalFetch = global.fetch;
  let requestBody;
  const analysis = {
    signal: 'WAIT', confidence: 64, horizon: 'Next 3 completed bars',
    summary: 'The chart is consolidating beneath recent resistance.',
    reasoning: 'EMA alignment is positive but momentum is mixed.',
    bullishFactors: ['EMA 9 remains above EMA 21'],
    bearishFactors: ['RSI momentum is not expanding'],
    invalidation: 'A close above the recent range high invalidates the wait thesis.'
  };
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/api/v1/chat')) {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output: [
          { type: 'reasoning', content: 'reasoning data should not be parsed as the final answer' },
          { type: 'message', content: JSON.stringify(analysis) }
        ],
        stats: { total_output_tokens: 200, reasoning_output_tokens: 40 }
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const result = await analyzeMarket('http://127.0.0.1:1234/v1', 'qwen/qwen3.5-9b', snapshot);
    assert.equal(result.analysis.signal, 'WAIT');
    assert.equal(result.analysis.confidence, 64);
    assert.equal(result.apiMode, 'native /api/v1/chat');
    assert.equal(requestBody.reasoning, 'off');
    assert.equal(requestBody.max_output_tokens, 1400);
    assert.equal(requestBody.store, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('empty OpenAI response reports token exhaustion details instead of claiming chat is unsupported', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '', reasoning_content: 'Thinking Process...' }, finish_reason: 'length' }],
    usage: { completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 30 } }
  }), { status: 200 });
  try {
    await assert.rejects(
      chatCompletion('http://127.0.0.1:1234/v1', 'qwen/qwen3.5-9b', [{ role: 'user', content: 'test' }], { maxTokens: 30 }),
      /token limit.*finish_reason: length.*reasoning tokens: 30/i
    );
  } finally {
    global.fetch = originalFetch;
  }
});


test('native chat reports when reasoning consumes the entire output budget without a final answer', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    output: [{ type: 'reasoning', content: 'long internal reasoning' }],
    stats: { total_output_tokens: 1400, reasoning_output_tokens: 1360 }
  }), { status: 200 });
  try {
    await assert.rejects(
      nativeChat('http://127.0.0.1:1234/v1', 'qwen/qwen3.5-9b', [{ role: 'user', content: 'Analyze.' }], { reasoning: 'off', maxOutputTokens: 1400 }),
      /output budget was effectively consumed by reasoning/i
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('native chat retries an unsupported reasoning level with explicit OFF', async () => {
  const originalFetch = global.fetch;
  const requestBodies = [];
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: "Reasoning setting 'low' is not supported. Supported settings: 'off', 'on'." } }), { status: 400 });
    }
    return new Response(JSON.stringify({ output: [{ type: 'message', content: 'READY' }] }), { status: 200 });
  };
  try {
    const result = await nativeChat('http://127.0.0.1:1234/v1', 'qwen/qwen3.5-9b', [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Say READY.' }
    ], { reasoning: 'low', maxOutputTokens: 1400 });
    assert.equal(result.content, 'READY');
    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0].reasoning, 'low');
    assert.equal(requestBodies[1].reasoning, 'off');
  } finally {
    global.fetch = originalFetch;
  }
});

test('native chat omits reasoning only when a model explicitly rejects OFF too', async () => {
  const originalFetch = global.fetch;
  const requestBodies = [];
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requestBodies.push(body);
    if (requestBodies.length <= 2) {
      return new Response(JSON.stringify({ error: { message: 'Model does not support reasoning' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ output: [{ type: 'message', content: 'READY' }] }), { status: 200 });
  };
  try {
    const result = await nativeChat('http://127.0.0.1:1234/v1', 'plain-model', [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Say READY.' }
    ], { reasoning: 'off', maxOutputTokens: 128 });
    assert.equal(result.content, 'READY');
    assert.equal(requestBodies.length, 3);
    assert.equal(requestBodies[0].reasoning, 'off');
    assert.equal(requestBodies[1].reasoning, 'off');
    assert.equal(Object.hasOwn(requestBodies[2], 'reasoning'), false);
  } finally {
    global.fetch = originalFetch;
  }
});
