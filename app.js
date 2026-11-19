(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const assets = {
    AAPL: { name: 'Apple Inc.', provider: 'AAPL', icon: 'A', iconClass: 'stock-icon', market: 'NASDAQ', decimals: 2, quoteType: 'EQUITY' },
    MSFT: { name: 'Microsoft Corporation', provider: 'MSFT', icon: 'M', iconClass: 'stock-icon', market: 'NASDAQ', decimals: 2, quoteType: 'EQUITY' },
    NVDA: { name: 'NVIDIA Corporation', provider: 'NVDA', icon: 'N', iconClass: 'stock-icon', market: 'NASDAQ', decimals: 2, quoteType: 'EQUITY' },
    AMZN: { name: 'Amazon.com, Inc.', provider: 'AMZN', icon: 'A', iconClass: 'stock-icon', market: 'NASDAQ', decimals: 2, quoteType: 'EQUITY' },
    GOOGL: { name: 'Alphabet Inc.', provider: 'GOOGL', icon: 'G', iconClass: 'stock-icon', market: 'NASDAQ', decimals: 2, quoteType: 'EQUITY' },
    META: { name: 'Meta Platforms, Inc.', provider: 'META', icon: 'M', iconClass: 'stock-icon', market: 'NASDAQ', decimals: 2, quoteType: 'EQUITY' },
    TSLA: { name: 'Tesla, Inc.', provider: 'TSLA', icon: 'T', iconClass: 'stock-icon', market: 'NASDAQ', decimals: 2, quoteType: 'EQUITY' },
    IBM: { name: 'International Business Machines Corporation', provider: 'IBM', icon: 'I', iconClass: 'stock-icon', market: 'NYSE', decimals: 2, quoteType: 'EQUITY' },
    JPM: { name: 'JPMorgan Chase & Co.', provider: 'JPM', icon: 'J', iconClass: 'stock-icon', market: 'NYSE', decimals: 2, quoteType: 'EQUITY' },
    // QQQ is retained as a Nasdaq-listed ETF, not a common stock.
    QQQ: { name: 'Invesco QQQ Trust', provider: 'QQQ', icon: 'Q', iconClass: 'qqq-icon', market: 'NASDAQ', decimals: 2, quoteType: 'ETF' },
    BTCUSD: { name: 'Bitcoin / U.S. Dollar', provider: 'BTC-USD', icon: '₿', iconClass: 'btc-icon', market: 'CRYPTO', decimals: 2, quoteType: 'CRYPTOCURRENCY' },
    ETHUSD: { name: 'Ethereum / U.S. Dollar', provider: 'ETH-USD', icon: '◆', iconClass: 'eth-icon', market: 'CRYPTO', decimals: 2, quoteType: 'CRYPTOCURRENCY' }
  };

  const POLL_SECONDS = 15;
  const LM_SETTINGS_KEY = 'chartscanner.deepLive.lmStudio.settings.v1';
  const DEFAULT_LM_SETTINGS = { baseUrl: 'http://127.0.0.1:1234/v1', model: '', enabled: false, autoAnalyze: false };
  function readLmSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(LM_SETTINGS_KEY) || 'null');
      return { ...DEFAULT_LM_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
    } catch {
      return { ...DEFAULT_LM_SETTINGS };
    }
  }
  const state = {
    symbol: 'AAPL', timeframe: '5m', showLevels: true, showCandles: true,
    paused: false, countdown: POLL_SECONDS, round: 0, activeTab: 'levels',
    marketData: {}, candleData: [], history: [], toastTimer: null,
    inflight: new Set(), watchlistRefreshing: false, lastError: null, searchTimer: null, searchRequestId: 0,
    marketDataRevision: 0,
    lmStudio: { ...readLmSettings(), analysisInFlight: false, pendingAutoAnalysis: false, lastAnalysisKey: null }
  };

  const fmt = (value, decimals = 2) => Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const currentAsset = () => assets[state.symbol];
  const marketKey = (symbol = state.symbol, timeframe = state.timeframe) => `${symbol}:${timeframe}`;
  const currentMarket = () => state.marketData[marketKey()] || null;
  const currentPrice = () => currentMarket()?.currentPrice ?? state.candleData.at(-1)?.close ?? null;
  const setText = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
  const money = (value) => Number.isFinite(value) ? fmt(value, currentAsset().decimals) : '—';

  function formatVolume(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
    return Math.round(value).toLocaleString('en-US');
  }

  function formatBarTime(timestamp, timezone, withDate = false) {
    if (!Number.isFinite(timestamp)) return '—';
    try {
      return new Intl.DateTimeFormat('en-US', withDate
        ? { timeZone: timezone || 'UTC', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
        : { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp * 1000));
    } catch {
      return new Date(timestamp * 1000).toISOString().slice(11, 16);
    }
  }

  function averageRange(data = state.candleData, count = 20) {
    const recent = data.slice(-count);
    if (!recent.length) return null;
    return recent.reduce((sum, candle) => sum + Math.max(0, candle.high - candle.low), 0) / recent.length;
  }

  function stepSize() {
    const price = currentPrice() || 1;
    return Math.max(averageRange() || price * 0.001, price * 0.00002);
  }

  function aggregateFourHourBars(bars) {
    const buckets = new Map();
    const bucketSeconds = 4 * 60 * 60;
    bars.forEach(bar => {
      const bucket = Math.floor(bar.time / bucketSeconds) * bucketSeconds;
      const existing = buckets.get(bucket);
      if (!existing) {
        buckets.set(bucket, { time: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0 });
      } else {
        existing.high = Math.max(existing.high, bar.high);
        existing.low = Math.min(existing.low, bar.low);
        existing.close = bar.close;
        existing.volume += bar.volume || 0;
      }
    });
    return [...buckets.values()].sort((a, b) => a.time - b.time);
  }

  function visibleBars(data) {
    const bars = state.timeframe === '4h' ? aggregateFourHourBars(data) : data;
    return bars.slice(-100);
  }

  function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function setFeedStatus(status, detail, mode = 'ok') {
    const title = $('#feedStatusTitle');
    const desc = $('#feedStatusDetail');
    const square = $('.status-square');
    if (title) title.textContent = status;
    if (desc) desc.textContent = detail;
    if (square) {
      const colors = { ok: '#27d68a', loading: '#efbd56', error: '#ff667a', stale: '#efbd56' };
      square.style.background = colors[mode] || colors.ok;
      square.style.boxShadow = `0 0 9px ${colors[mode] || colors.ok}55`;
    }
  }

  function setLmSettingsStatus(message, mode = 'neutral') {
    const node = $('#lmSettingsStatus');
    if (!node) return;
    node.textContent = message;
    node.className = `lm-settings-status${mode === 'success' ? ' success' : mode === 'error' ? ' error' : ''}`;
  }

  function setLmResultStatus(message) {
    setText('#lmResultState', message);
  }

  function resetLmResult(message = 'LOCAL INDICATORS ONLY') {
    setLmResultStatus(message);
    setText('#lmResultSummary', state.lmStudio.enabled
      ? 'New chart data is available. Run analysis to request an updated LM Studio interpretation.'
      : 'Connect and enable a model in Settings to add an independent interpretation of the current chart and indicators.');
    setText('#lmInvalidation', 'Local indicator calculations remain active when LM Studio is unavailable or disabled.');
    renderLmFactorList('#lmBullishFactors', [], 'Awaiting model analysis');
    renderLmFactorList('#lmBearishFactors', [], 'Awaiting model analysis');
  }

  function renderLmFactorList(selector, values, emptyLabel) {
    const node = $(selector);
    if (!node) return;
    node.replaceChildren();
    const items = Array.isArray(values) && values.length ? values : [emptyLabel];
    items.forEach(value => {
      const item = document.createElement('li');
      item.textContent = value;
      node.append(item);
    });
  }

  function populateLmSettingsForm() {
    $('#lmBaseUrl').value = state.lmStudio.baseUrl || DEFAULT_LM_SETTINGS.baseUrl;
    $('#lmModelInput').value = state.lmStudio.model || '';
    $('#lmEnabled').checked = Boolean(state.lmStudio.enabled);
    $('#lmAutoAnalyze').checked = Boolean(state.lmStudio.autoAnalyze);
  }

  function setLmSettingsBusy(busy, buttonId, busyText, normalText) {
    const button = $(buttonId);
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? busyText : normalText;
  }

  async function postLmStudio(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || payload.error || `LM Studio API returned HTTP ${response.status}`);
    return payload;
  }

  async function loadLmModels() {
    const baseUrl = $('#lmBaseUrl').value.trim();
    setLmSettingsBusy(true, '#lmLoadModels', 'Loading…', 'Load models');
    setLmSettingsStatus('Querying LM Studio /v1/models…');
    try {
      const payload = await postLmStudio('/api/lmstudio/models', { baseUrl });
      const datalist = $('#lmModelOptions');
      datalist.replaceChildren();
      (payload.models || []).forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        datalist.append(option);
      });
      if (!$('#lmModelInput').value.trim() && payload.models?.length) {
        $('#lmModelInput').value = payload.models[0].id;
      }
      if (!payload.models?.length) {
        setLmSettingsStatus('LM Studio responded, but no models were returned. Load a model in LM Studio first.', 'error');
      } else {
        setLmSettingsStatus(`Connected to ${payload.baseUrl}. Found ${payload.models.length} model(s): ${payload.models.map(item => item.id).join(', ')}`, 'success');
      }
    } catch (error) {
      setLmSettingsStatus(error.message, 'error');
    } finally {
      setLmSettingsBusy(false, '#lmLoadModels', 'Loading…', 'Load models');
    }
  }

  async function testLmStudioConnection() {
    const baseUrl = $('#lmBaseUrl').value.trim();
    const model = $('#lmModelInput').value.trim();
    setLmSettingsBusy(true, '#lmTestConnection', 'Testing…', 'Test connection');
    setLmSettingsStatus('Testing model discovery and chat completion. The first request can take longer while the model initializes…');
    try {
      const payload = await postLmStudio('/api/lmstudio/test', { baseUrl, model });
      $('#lmModelInput').value = payload.model;
      const datalist = $('#lmModelOptions');
      datalist.replaceChildren();
      (payload.models || []).forEach(item => {
        const option = document.createElement('option');
        option.value = item.id;
        datalist.append(option);
      });
      setLmSettingsStatus(`Success. ${payload.model} answered via ${payload.apiMode || 'LM Studio chat API'} at ${payload.baseUrl}. Response: ${payload.response}`, 'success');
    } catch (error) {
      setLmSettingsStatus(error.message, 'error');
    } finally {
      setLmSettingsBusy(false, '#lmTestConnection', 'Testing…', 'Test connection');
    }
  }

  function saveLmStudioSettings() {
    const config = {
      baseUrl: $('#lmBaseUrl').value.trim() || DEFAULT_LM_SETTINGS.baseUrl,
      model: $('#lmModelInput').value.trim(),
      enabled: $('#lmEnabled').checked,
      autoAnalyze: $('#lmAutoAnalyze').checked
    };
    if (config.enabled && !config.model) {
      setLmSettingsStatus('Choose or enter a model ID before enabling LM Studio analysis.', 'error');
      return;
    }
    Object.assign(state.lmStudio, config, { lastAnalysisKey: null, pendingAutoAnalysis: false });
    try { localStorage.setItem(LM_SETTINGS_KEY, JSON.stringify(config)); } catch (error) {
      console.warn('Could not persist LM Studio settings:', error.message);
    }
    if (state.candleData.length >= 8) updateAnalysis();
    resetLmResult(config.enabled ? 'LM STUDIO READY · RUN ANALYSIS' : 'LOCAL INDICATORS ONLY');
    setLmSettingsStatus(config.enabled
      ? `Settings saved. ${config.model} will interpret ${config.autoAnalyze ? 'each refreshed chart' : 'charts when you click Run analysis'}.`
      : 'Settings saved. Local indicator analysis remains active; LM Studio is disabled.', 'success');
    showToast(config.enabled ? 'LM Studio settings saved' : 'LM Studio integration disabled');
    if (config.enabled && config.autoAnalyze && state.candleData.length >= 8) {
      $('#lmSettingsBackdrop').hidden = true;
      runLmStudioAnalysis();
    }
  }

  function buildLmSnapshot() {
    const asset = currentAsset();
    const market = currentMarket();
    const snapshot = technicalSnapshot();
    if (!snapshot || state.candleData.length < 8) throw new Error('Load at least eight chart bars before requesting LM Studio analysis.');
    const scoreA = snapshot.marketScore;
    const scoreB = snapshot.patternScore;
    const scoreC = snapshot.macdScore;
    const combined = Math.round(scoreA * 0.4 + scoreB * 0.35 + scoreC * 0.25);
    const recent = state.candleData.slice(-20);
    const rangeHigh20 = Math.max(...recent.map(bar => bar.high));
    const rangeLow20 = Math.min(...recent.map(bar => bar.low));
    return {
      symbol: state.symbol,
      assetName: asset.name,
      assetType: asset.quoteType === 'CRYPTOCURRENCY' ? 'cryptocurrency' : asset.quoteType === 'ETF' ? 'ETF' : 'common stock',
      exchange: market?.exchange || asset.market,
      interval: state.timeframe,
      currency: market?.currency || 'unknown',
      fetchedAt: market?.fetchedAt || '',
      stale: Boolean(market?.stale),
      currentPrice: currentPrice(),
      changePercent: market?.changePercent ?? null,
      indicators: {
        ema9: snapshot.ema9,
        ema21: snapshot.ema21,
        ema12: snapshot.ema12,
        ema26: snapshot.ema26,
        rsi14: snapshot.rsi,
        momentum6Bars: snapshot.momentum,
        atr14: snapshot.atr,
        rangeHigh20,
        rangeLow20,
        rangePositionPct: rangeHigh20 > rangeLow20 ? ((currentPrice() - rangeLow20) / (rangeHigh20 - rangeLow20)) * 100 : 50,
        trendScore: scoreA,
        patternScore: scoreB,
        momentumScore: scoreC,
        localCombinedScore: combined,
        localSignal: combined >= 57 ? 'BUY' : combined <= 43 ? 'SELL' : 'WAIT'
      },
      bars: state.candleData.slice(-40).map(bar => ({
        time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0
      }))
    };
  }

  function applyLmStudioAnalysis(payload) {
    const analysis = payload.analysis;
    const signal = analysis.signal;
    const confidence = analysis.confidence;
    const classes = { BUY: 'bullish', SELL: 'bearish', WAIT: 'neutral' };
    const icons = { BUY: '↗', SELL: '↘', WAIT: '↔' };
    const colors = { BUY: '#4bd69b', SELL: '#ff8290', WAIT: '#eac46c' };
    const pressure = signal === 'BUY' ? confidence : signal === 'SELL' ? 100 - confidence : 50;

    $('#verdictMain').className = `verdict-main ${classes[signal]}`;
    setText('#verdictIcon', icons[signal]);
    setText('#verdictText', signal);
    setText('#verdictDetail', `LM Studio · ${analysis.horizon}`);
    setText('#timeHorizon', analysis.horizon);
    setText('#confidenceRing', `${confidence}%`);
    $('#confidenceRing').style.borderColor = colors[signal];
    $('#confidenceRing').style.color = colors[signal];
    setText('#probability', `${confidence}%`);
    const probabilityLabel = $('.verdict-stats div:first-child span');
    if (probabilityLabel) probabilityLabel.textContent = 'MODEL CONFIDENCE';
    setText('#buyPressureLabel', `${Math.round(pressure)}%`);
    $('#buyPressureBar').style.width = `${pressure}%`;
    setText('#consensusText', `LM STUDIO ${signal}`);
    $('#consensusText').style.color = colors[signal];
    setText('#consensusSubtext', analysis.summary);
    setText('#lmResultState', `${payload.model} · ${confidence}%`);
    setText('#lmResultSummary', analysis.reasoning);
    renderLmFactorList('#lmBullishFactors', analysis.bullishFactors, 'No specific bullish factor supplied');
    renderLmFactorList('#lmBearishFactors', analysis.bearishFactors, 'No specific risk factor supplied');
    setText('#lmInvalidation', `Horizon: ${analysis.horizon}. Reassess: ${analysis.invalidation}`);
    setText('#verdictUpdated', new Date(payload.analyzedAt || Date.now()).toLocaleTimeString('en-US', { hour12: false }));
    const source = state.lmStudio.autoAnalyze ? 'LM STUDIO AUTO' : 'LM STUDIO MANUAL';
    setLmResultStatus(source);
  }

  async function runLmStudioAnalysis() {
    const config = state.lmStudio;
    if (!config.model) {
      resetLmResult('MODEL NOT CONFIGURED');
      showToast('Open Settings and choose your LM Studio model first.');
      return null;
    }
    if (config.analysisInFlight) {
      if (config.enabled && config.autoAnalyze) config.pendingAutoAnalysis = true;
      else showToast('LM Studio is already analyzing this chart.');
      return null;
    }
    const symbol = state.symbol;
    const timeframe = state.timeframe;
    const marketRevision = state.marketDataRevision;
    let snapshot;
    try { snapshot = buildLmSnapshot(); } catch (error) {
      setLmResultStatus('INSUFFICIENT DATA');
      setText('#lmResultSummary', error.message);
      showToast(error.message);
      return null;
    }

    config.analysisInFlight = true;
    const requestBaseUrl = config.baseUrl;
    const requestModel = config.model;
    setLmResultStatus('MODEL RUNNING…');
    setText('#lmResultSummary', `Sending ${snapshot.bars.length} candles and the local indicator snapshot to ${requestModel}…`);
    setLmSettingsStatus(`Analyzing ${symbol} ${timeframe} with ${requestModel}…`);
    try {
      const payload = await postLmStudio('/api/lmstudio/analyze', {
        baseUrl: requestBaseUrl,
        model: requestModel,
        snapshot
      });
      if (symbol !== state.symbol || timeframe !== state.timeframe || !config.enabled || config.model !== requestModel || config.baseUrl !== requestBaseUrl) return null;
      if (marketRevision !== state.marketDataRevision) {
        if (config.autoAnalyze) config.pendingAutoAnalysis = true;
        setLmResultStatus('NEWER DATA AVAILABLE · MODEL RESULT SKIPPED');
        setText('#lmResultSummary', 'The chart updated while this model request was running. The older analysis was discarded to avoid showing a stale decision.');
        return null;
      }
      applyLmStudioAnalysis(payload);
      const lastBar = snapshot.bars.at(-1)?.time || 'none';
      config.lastAnalysisKey = `${symbol}:${timeframe}:${lastBar}`;
      setLmSettingsStatus(`Last analysis completed for ${symbol} ${timeframe} using ${payload.model}.`, 'success');
      return payload;
    } catch (error) {
      if (symbol === state.symbol && timeframe === state.timeframe) {
        setLmResultStatus('MODEL ERROR · LOCAL MODE');
        setText('#lmResultSummary', error.message);
        setText('#lmInvalidation', 'The local indicator result remains active. Check LM Studio server status, loaded model ID, and base URL in Settings.');
      }
      setLmSettingsStatus(error.message, 'error');
      showToast(`LM Studio analysis failed: ${error.message}`);
      return null;
    } finally {
      config.analysisInFlight = false;
      if (config.pendingAutoAnalysis && config.enabled && config.autoAnalyze) {
        config.pendingAutoAnalysis = false;
        queueMicrotask(() => runLmStudioAnalysis());
      }
    }
  }

  function appendAssetRow(container, symbol, asset) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `asset-row${symbol === state.symbol ? ' active' : ''}`;
    button.dataset.symbol = symbol;

    const icon = document.createElement('span');
    icon.className = `asset-coin ${asset.iconClass || 'stock-icon'}`;
    icon.textContent = asset.icon || symbol.slice(0, 1);

    const meta = document.createElement('span');
    meta.className = 'asset-meta';
    const ticker = document.createElement('strong');
    ticker.textContent = symbol;
    const description = document.createElement('small');
    description.textContent = `${asset.name} · ${asset.market}${asset.quoteType === 'ETF' ? ' ETF' : asset.quoteType === 'CRYPTOCURRENCY' ? ' crypto' : ''}`;
    meta.append(ticker, description);

    const quote = document.createElement('span');
    quote.className = 'asset-price';
    const price = document.createElement('strong');
    price.className = 'mono';
    price.textContent = '—';
    const change = document.createElement('small');
    change.textContent = 'Load 5m chart';
    quote.append(price, change);

    button.append(icon, meta, quote);
    button.addEventListener('click', () => setAsset(symbol));
    container.append(button);
    updateWatchlistRow(symbol, state.marketData[marketKey(symbol, '5m')]);
  }

  function renderAssetList() {
    const container = $('#assetList');
    container.replaceChildren();
    Object.entries(assets).forEach(([symbol, asset]) => appendAssetRow(container, symbol, asset));
    setText('.scanner-count', `${Object.keys(assets).length.toString().padStart(2, '0')} WATCHLIST`);
  }

  function renderSearchMessage(message) {
    const container = $('#assetList');
    container.replaceChildren();
    const note = document.createElement('div');
    note.className = 'empty-results';
    note.textContent = message;
    container.append(note);
  }

  function renderSearchResults(results) {
    const container = $('#assetList');
    container.replaceChildren();
    if (!results.length) {
      renderSearchMessage('No matching NYSE/Nasdaq stock or cryptocurrency found. Try a ticker or name.');
      return;
    }

    results.forEach(stock => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'asset-row search-result-row';
      button.dataset.searchSymbol = stock.symbol;

      const icon = document.createElement('span');
      icon.className = `asset-coin ${stock.assetClass === 'CRYPTO' ? (stock.symbol.startsWith('BTC') ? 'btc-icon' : stock.symbol.startsWith('ETH') ? 'eth-icon' : 'qqq-icon') : 'stock-icon'}`;
      icon.textContent = stock.assetClass === 'CRYPTO' && stock.symbol.startsWith('BTC') ? '₿' : stock.symbol.slice(0, 1);

      const meta = document.createElement('span');
      meta.className = 'asset-meta';
      const ticker = document.createElement('strong');
      ticker.textContent = stock.symbol;
      const company = document.createElement('small');
      company.textContent = stock.name;
      meta.append(ticker, company);

      const exchange = document.createElement('span');
      exchange.className = 'search-exchange';
      exchange.textContent = stock.assetClass === 'CRYPTO' ? 'CRYPTO' : stock.exchange;
      button.append(icon, meta, exchange);
      button.addEventListener('click', () => selectSearchStock(stock));
      container.append(button);
    });
  }

  async function searchStocks(query, requestId) {
    renderSearchMessage(`Searching NYSE/Nasdaq stocks and crypto for “${query}”…`);
    setText('.scanner-count', 'SEARCHING');
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        cache: 'no-store', headers: { 'Accept': 'application/json' }
      });
      const payload = await response.json().catch(() => ({}));
      if (requestId !== state.searchRequestId) return;
      if (!response.ok) throw new Error(payload.detail || payload.error || `Search failed (HTTP ${response.status})`);
      renderSearchResults(Array.isArray(payload.results) ? payload.results : []);
      setText('.scanner-count', `${payload.results?.length || 0} RESULTS`);
    } catch (error) {
      if (requestId !== state.searchRequestId) return;
      renderSearchMessage(`Asset search failed: ${error.message}`);
      setText('.scanner-count', 'SEARCH ERROR');
    }
  }

  function selectSearchStock(stock) {
    assets[stock.symbol] = {
      name: stock.name,
      provider: stock.providerSymbol || stock.symbol,
      icon: stock.assetClass === 'CRYPTO' && stock.symbol.startsWith('BTC') ? '₿' : stock.symbol.slice(0, 1),
      iconClass: stock.assetClass === 'CRYPTO' ? (stock.symbol.startsWith('BTC') ? 'btc-icon' : stock.symbol.startsWith('ETH') ? 'eth-icon' : 'qqq-icon') : 'stock-icon',
      market: stock.assetClass === 'CRYPTO' ? 'CRYPTO' : stock.exchange,
      decimals: 2,
      quoteType: stock.quoteType || 'EQUITY',
      assetClass: stock.assetClass || 'STOCK'
    };
    $('#symbolSearch').value = '';
    state.searchRequestId++;
    renderAssetList();
    if (stock.symbol === state.symbol) {
      state.countdown = POLL_SECONDS;
      fetchMarketData({ force: true, quiet: false, analyze: state.lmStudio.enabled && state.lmStudio.autoAnalyze });
    } else {
      setAsset(stock.symbol);
    }
  }

  function setAsset(symbol) {
    if (!assets[symbol] || symbol === state.symbol) return;
    state.symbol = symbol;
    state.lmStudio.lastAnalysisKey = null;
    resetLmResult(state.lmStudio.enabled ? 'NEW SYMBOL · MODEL NOT RUN' : 'LOCAL INDICATORS ONLY');
    state.candleData = visibleBars(currentMarket()?.bars || []);
    $$('.asset-row').forEach(row => row.classList.toggle('active', row.dataset.symbol === symbol));
    updateAssetUI();
    updateAnalysis();
    renderTab();
    drawChart();
    state.countdown = POLL_SECONDS;
    fetchMarketData({ force: true, quiet: false, analyze: state.lmStudio.enabled && state.lmStudio.autoAnalyze });
  }

  function updateWatchlistRow(symbol, market) {
    const row = $(`.asset-row[data-symbol="${symbol}"]`);
    if (!row || !market) return;
    const priceNode = row.querySelector('.asset-price strong');
    const changeNode = row.querySelector('.asset-price small');
    const price = market.currentPrice ?? market.bars?.at(-1)?.close;
    const changePct = market.changePercent;
    if (priceNode && Number.isFinite(price)) priceNode.textContent = fmt(price, assets[symbol].decimals);
    if (changeNode && Number.isFinite(changePct)) {
      changeNode.textContent = `${changePct >= 0 ? '+' : '−'}${Math.abs(changePct).toFixed(2)}%`;
      changeNode.className = changePct >= 0 ? 'positive-text' : 'negative-text';
    } else if (changeNode) {
      changeNode.textContent = 'Data loaded';
      changeNode.className = '';
    }
  }

  async function refreshWatchlistQuotes() {
    if (state.paused || state.watchlistRefreshing) return;
    state.watchlistRefreshing = true;
    try {
      for (const symbol of Object.keys(assets)) {
        if (state.paused) break;
        if (symbol === state.symbol) continue;
        try {
          const response = await fetch(`/api/market?symbol=${encodeURIComponent(symbol)}&interval=5m`, {
            cache: 'no-store', headers: { 'Accept': 'application/json' }
          });
          if (!response.ok) continue;
          const payload = await response.json();
          if (!Array.isArray(payload.bars) || !payload.bars.length) continue;
          const cached = { ...payload, bars: payload.bars.slice(-100) };
          state.marketData[marketKey(symbol, '5m')] = cached;
          updateWatchlistRow(symbol, cached);
        } catch (error) {
          console.debug(`Watchlist quote refresh skipped for ${symbol}:`, error.message);
        }
      }
    } finally {
      state.watchlistRefreshing = false;
    }
  }

  function updateAssetUI() {
    const asset = currentAsset();
    const market = currentMarket();
    const price = currentPrice();
    $('#instrumentIcon').textContent = asset.icon;
    $('#instrumentIcon').className = `instrument-icon ${asset.iconClass}`;
    $('#symbolName').textContent = state.symbol;
    $('#instrumentDescription').textContent = `${asset.name} · Yahoo ticker ${asset.provider}`;
    $('.market-tag').textContent = market?.exchange ? market.exchange.toUpperCase().slice(0, 14) : asset.market;
    setText('#mainPrice', money(price));

    if (!market || !Number.isFinite(price)) {
      $('#mainChange').textContent = 'Waiting for market data';
      $('#mainChange').className = 'price-change';
      ['#highStat', '#lowStat', '#volumeStat', '#volatilityStat', '#ohlcO', '#ohlcH', '#ohlcL', '#ohlcC'].forEach(id => setText(id, '—'));
      setText('#levelCurrent', '—');
      setText('#resistance1', '—'); setText('#resistance2', '—');
      setText('#support1', '—'); setText('#support2', '—');
      setText('#entryLevel', '—'); setText('#stopLevel', '—');
      setText('#targetOne', '—'); setText('#targetTwo', '—');
      setText('#tradeDirection', 'WAITING FOR DATA');
      setText('#rrRatio', '—');
      setText('#lastUpdated', state.lastError ? 'Market data unavailable' : 'Connecting to Yahoo Finance…');
      return;
    }

    const previousClose = market.previousClose;
    const changeAmount = Number.isFinite(previousClose) ? price - previousClose : null;
    const changePct = Number.isFinite(market.changePercent) ? market.changePercent : null;
    if (changeAmount !== null && changePct !== null) {
      const positive = changePct >= 0;
      $('#mainChange').textContent = `${positive ? '+' : '−'}${fmt(Math.abs(changeAmount), asset.decimals)} (${positive ? '+' : '−'}${Math.abs(changePct).toFixed(2)}%)`;
      $('#mainChange').className = `price-change ${positive ? 'positive' : 'negative'}`;
    } else {
      $('#mainChange').textContent = 'Change unavailable';
      $('#mainChange').className = 'price-change';
    }

    const dayBars = state.candleData;
    const dayHigh = market.dayHigh ?? Math.max(...dayBars.map(c => c.high));
    const dayLow = market.dayLow ?? Math.min(...dayBars.map(c => c.low));
    const volume = market.dayVolume || dayBars.reduce((sum, candle) => sum + (candle.volume || 0), 0);
    const avgRangePct = (averageRange(dayBars) || 0) / Math.max(price, 0.000001) * 100;
    const volatility = avgRangePct < 0.12 ? 'Low' : avgRangePct < 0.55 ? 'Medium' : 'High';
    setText('#highStat', money(dayHigh));
    setText('#lowStat', money(dayLow));
    setText('#volumeStat', formatVolume(volume));
    setText('#volatilityStat', volatility);

    const last = dayBars.at(-1);
    setText('#ohlcO', money(last?.open));
    setText('#ohlcH', money(last?.high));
    setText('#ohlcL', money(last?.low));
    setText('#ohlcC', money(last?.close));

    const unit = stepSize();
    setText('#levelCurrent', money(price));
    setText('#resistance1', money(price + unit * 1.8));
    setText('#resistance2', money(price + unit * 3.5));
    setText('#support1', money(price - unit * 1.8));
    setText('#support2', money(price - unit * 3.5));

    const direction = (changePct ?? 0) >= 0 ? 1 : -1;
    const entryA = price - unit * 0.22 * direction;
    const entryB = price + unit * 0.22 * direction;
    setText('#entryLevel', `${money(Math.min(entryA, entryB))} – ${money(Math.max(entryA, entryB))}`);
    setText('#stopLevel', money(price - unit * 1.7 * direction));
    setText('#targetOne', money(price + unit * 2.0 * direction));
    setText('#targetTwo', money(price + unit * 3.4 * direction));
    $('#tradeDirection').textContent = direction > 0 ? 'LONG BIAS' : 'SHORT BIAS';
    $('#tradeDirection').style.color = direction > 0 ? '#4bd59a' : '#ff8390';
    setText('#rrRatio', '1 : 2.0');

    const lastBarTime = last?.time;
    setText('#lastUpdated', `${market.stale ? 'Cached Yahoo data' : 'Yahoo Finance bars'} · ${formatBarTime(lastBarTime, market.timezone, true)}`);
    setText('#exchangeTime', formatBarTime(lastBarTime, market.timezone, true) + ` ${market.timezone || ''}`);

    updateWatchlistRow(state.symbol, market);
  }

  function calculateEMA(values, period) {
    if (!values.length) return [];
    const multiplier = 2 / (period + 1);
    const result = [values[0]];
    for (let i = 1; i < values.length; i++) {
      result.push((values[i] - result[i - 1]) * multiplier + result[i - 1]);
    }
    return result;
  }

  function calculateRSI(closes, period = 14) {
    if (closes.length <= period) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    if (losses === 0) return gains === 0 ? 50 : 100;
    const rs = (gains / period) / (losses / period);
    return 100 - (100 / (1 + rs));
  }

  function technicalSnapshot() {
    const bars = state.candleData;
    if (bars.length < 8) return null;
    const closes = bars.map(bar => bar.close);
    const last = closes.at(-1);
    const ema9 = calculateEMA(closes, 9).at(-1);
    const ema21 = calculateEMA(closes, 21).at(-1);
    const ema12 = calculateEMA(closes, 12).at(-1);
    const ema26 = calculateEMA(closes, 26).at(-1);
    const atr = averageRange(bars, 14) || Math.max(last * 0.0001, 0.000001);
    const momentum = last - closes[Math.max(0, closes.length - 6)];
    const rsi = calculateRSI(closes, 14);
    const recent = bars.slice(-20);
    const recentHigh = Math.max(...recent.map(bar => bar.high));
    const recentLow = Math.min(...recent.map(bar => bar.low));
    const range = Math.max(recentHigh - recentLow, atr);
    const rangePosition = clamp((last - recentLow) / range, 0, 1);

    const marketScore = clamp(50 + ((ema9 - ema21) / atr) * 17 + (momentum / atr) * 2.4, 3, 97);
    const patternScore = clamp(50 + (rangePosition - 0.5) * 56 + (momentum / atr) * 1.2, 3, 97);
    const macdScore = clamp(50 + ((ema12 - ema26) / atr) * 28 + (rsi - 50) * 0.42, 3, 97);
    return { marketScore, patternScore, macdScore, rsi, momentum, atr, ema9, ema21, ema12, ema26 };
  }

  function updateAnalysis() {
    const probabilityLabel = $('.verdict-stats div:first-child span');
    if (probabilityLabel) probabilityLabel.textContent = 'INDICATOR SCORE';
    setText('#timeHorizon', '15 MIN');
    const snapshot = technicalSnapshot();
    if (!snapshot) {
      setText('#consensusText', 'WAITING FOR BARS');
      setText('#consensusSubtext', 'At least eight five-minute bars are needed for the local indicator calculation.');
      setText('#verdictText', 'WAIT');
      setText('#verdictDetail', 'Insufficient market history');
      setText('#summaryScore', '—');
      setText('#bullVotes', '—'); setText('#bearVotes', '—');
      setText('#roundNumber', '0000');
      setText('#confidenceRing', '—');
      setText('#probability', '—');
      setText('#marketScore', '—'); setText('#patternScore', '—'); setText('#macdScore', '—');
      ['market', 'pattern', 'macd'].forEach(id => {
        setText(`#${id}Vote`, 'WAIT');
        $(`#${id}Vote`).className = 'party-vote vote-wait';
        $(`#${id}Bar`).style.width = '0%';
      });
      $('#verdictMain').className = 'verdict-main neutral';
      setText('#tradeDirection', 'NO DATA');
      setText('#rrRatio', '—');
      return;
    }

    state.round += 1;
    const scoreA = Math.round(snapshot.marketScore);
    const scoreB = Math.round(snapshot.patternScore);
    const scoreC = Math.round(snapshot.macdScore);
    const score = Math.round(scoreA * 0.4 + scoreB * 0.35 + scoreC * 0.25);
    const verdict = score >= 57 ? 'BUY' : score <= 43 ? 'SELL' : 'WAIT';
    const labels = { BUY: 'BULLISH BIAS', SELL: 'BEARISH BIAS', WAIT: 'NEUTRAL / WAIT' };
    const classes = { BUY: 'bullish', SELL: 'bearish', WAIT: 'neutral' };
    const icons = { BUY: '↗', SELL: '↘', WAIT: '↔' };
    const colors = { BUY: '#4bd69b', SELL: '#ff8290', WAIT: '#eac46c' };
    const voteFor = value => value >= 58 ? 'BUY' : value <= 42 ? 'SELL' : 'WAIT';
    const parties = [
      ['market', scoreA, voteFor(scoreA)],
      ['pattern', scoreB, voteFor(scoreB)],
      ['macd', scoreC, voteFor(scoreC)]
    ];

    setText('#roundNumber', String(state.round).padStart(4, '0'));
    setText('#modelCycle', `#${String(state.round).padStart(5, '0')}`);
    setText('#summaryScore', String(score));
    $('#summaryGauge').style.background = `radial-gradient(circle, #0e2635 58%, transparent 60%), conic-gradient(${colors[verdict]} 0 ${score}%, #254255 ${score}% 100%)`;
    setText('#consensusText', labels[verdict]);
    $('#consensusText').style.color = colors[verdict];
    setText('#consensusSubtext', verdict === 'BUY'
      ? 'Short-term trend and momentum are aligned to the upside.'
      : verdict === 'SELL'
        ? 'Short-term trend and momentum are aligned to the downside.'
        : 'The indicator set is mixed; wait for clearer directional agreement.');
    setText('#bullVotes', String(parties.filter(p => p[2] === 'BUY').length * 8));
    setText('#bearVotes', String(parties.filter(p => p[2] === 'SELL').length * 8));

    parties.forEach(([id, value, vote]) => {
      setText(`#${id}Score`, String(value));
      $(`#${id}Bar`).style.width = `${value}%`;
      setText(`#${id}Vote`, vote);
      $(`#${id}Vote`).className = `party-vote ${vote === 'BUY' ? 'vote-buy' : vote === 'SELL' ? 'vote-sell' : 'vote-wait'}`;
    });

    $('#verdictMain').className = `verdict-main ${classes[verdict]}`;
    setText('#verdictIcon', icons[verdict]);
    setText('#verdictText', verdict);
    setText('#verdictDetail', verdict === 'BUY' ? 'Positive short-term indicator bias' : verdict === 'SELL' ? 'Negative short-term indicator bias' : 'Wait for indicator confirmation');
    setText('#confidenceRing', `${score}%`);
    $('#confidenceRing').style.borderColor = colors[verdict];
    $('#confidenceRing').style.color = colors[verdict];
    setText('#probability', `${score.toFixed(1)}%`);
    setText('#buyPressureLabel', `${score}%`);
    $('#buyPressureBar').style.width = `${score}%`;
    $('#buyPressureBar').style.borderColor = '#d9eef0';
    setText('#verdictUpdated', new Date().toLocaleTimeString('en-US', { hour12: false }));

    setText('#marketReason', `EMA 9 is ${snapshot.ema9 >= snapshot.ema21 ? 'above' : 'below'} EMA 21; recent close-to-close momentum is ${snapshot.momentum >= 0 ? 'positive' : 'negative'}.`);
    setText('#patternReason', `Price is ${Math.round((Math.max(...state.candleData.slice(-20).map(c => c.high)) - currentPrice()) / snapshot.atr)} ATR below the recent 20-bar high.`);
    setText('#macdReason', `RSI(14) is ${snapshot.rsi.toFixed(1)}. EMA 12 / EMA 26 spread is ${snapshot.ema12 === snapshot.ema26 ? 'flat' : (snapshot.ema12 > snapshot.ema26 ? 'positive' : 'negative')}.`);

    const market = currentMarket();
    state.history.unshift({
      time: new Date().toLocaleTimeString('en-US', { hour12: false }),
      verdict,
      score,
      price: money(currentPrice()),
      symbol: state.symbol,
      interval: state.timeframe,
      source: market?.provider || 'Yahoo Finance'
    });
    state.history = state.history.slice(0, 20);
    if (state.activeTab === 'history') renderTab();
  }

  function drawChart() {
    const canvas = $('#marketChart');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);
    const left = 12, right = 80, top = 17, bottom = 29;
    const plotW = w - left - right, plotH = h - top - bottom;
    const data = state.candleData;
    if (!data.length) {
      ctx.fillStyle = '#7890a5';
      ctx.font = '12px "DM Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(state.lastError ? 'Market data unavailable — check the local server connection' : 'Connecting to Yahoo Finance for 5-minute OHLCV bars…', w / 2, h / 2);
      return;
    }

    const asset = currentAsset();
    const unit = stepSize();
    const current = currentPrice() ?? data.at(-1).close;
    const rawMin = Math.min(...data.map(c => c.low), current);
    const rawMax = Math.max(...data.map(c => c.high), current);
    const padding = Math.max((rawMax - rawMin) * 0.08, unit * 0.6);
    const min = rawMin - padding;
    const max = rawMax + padding;
    const y = value => top + (max - value) / Math.max(max - min, 1e-12) * plotH;
    const xStep = plotW / data.length;
    const x = index => left + xStep * index + xStep / 2;

    ctx.strokeStyle = 'rgba(104,143,169,.13)';
    ctx.lineWidth = 1;
    ctx.font = '9px "DM Mono", monospace';
    ctx.fillStyle = '#6f8498';
    ctx.textAlign = 'left';
    for (let i = 0; i <= 5; i++) {
      const yy = top + plotH * i / 5;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(w - right + 7, yy); ctx.stroke();
      const value = max - (max - min) * i / 5;
      ctx.fillText(fmt(value, asset.decimals), w - right + 12, yy + 3);
    }
    for (let i = 0; i <= 6; i++) {
      const xx = left + plotW * i / 6;
      ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, h - bottom + 2); ctx.stroke();
    }

    if (state.showLevels) {
      [
        [current + unit * 1.8, '#f07886', 'R1'],
        [current - unit * 1.8, '#39ca91', 'S1']
      ].forEach(([value, color, label]) => {
        ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha = .52; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(w - right + 4, y(value)); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = color; ctx.globalAlpha = .8; ctx.font = '8px "DM Mono", monospace'; ctx.fillText(label, left + 4, y(value) - 4); ctx.restore();
      });
    }

    data.forEach((candle, index) => {
      const xx = x(index);
      const up = candle.close >= candle.open;
      const color = up ? '#30cb8d' : '#f06478';
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xx, y(candle.high)); ctx.lineTo(xx, y(candle.low)); ctx.stroke();
      const bodyTop = Math.min(y(candle.open), y(candle.close));
      const bodyBottom = Math.max(y(candle.open), y(candle.close));
      const bodyHeight = Math.max(1.5, bodyBottom - bodyTop);
      const bodyWidth = Math.max(2, Math.min(8, xStep * 0.6));
      if (state.showCandles) ctx.fillRect(xx - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
      else { ctx.beginPath(); ctx.arc(xx, y(candle.close), 1.6, 0, Math.PI * 2); ctx.fill(); }
    });

    // EMA 9 overlay is computed from the actual downloaded close prices.
    const ema = calculateEMA(data.map(candle => candle.close), 9);
    ctx.save(); ctx.strokeStyle = '#45cbe0'; ctx.lineWidth = 1.5; ctx.globalAlpha = .9;
    ctx.beginPath();
    ema.forEach((value, index) => {
      if (index === 0) ctx.moveTo(x(index), y(value));
      else ctx.lineTo(x(index), y(value));
    });
    ctx.stroke(); ctx.restore();

    ctx.save(); ctx.strokeStyle = 'rgba(80,211,220,.55)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(left, y(current)); ctx.lineTo(w - right + 5, y(current)); ctx.stroke(); ctx.restore();
    ctx.fillStyle = '#208f9e'; ctx.fillRect(w - right + 7, y(current) - 9, right - 8, 18);
    ctx.fillStyle = '#f1fbfc'; ctx.font = '9px "DM Mono", monospace'; ctx.textAlign = 'center';
    ctx.fillText(fmt(current, asset.decimals), w - right / 2 + 3, y(current) + 3);

    ctx.fillStyle = '#61788d'; ctx.font = '8px "DM Mono", monospace'; ctx.textAlign = 'center';
    for (let i = 0; i <= 6; i++) {
      const index = Math.min(data.length - 1, Math.round((data.length - 1) * i / 6));
      const label = formatBarTime(data[index].time, currentMarket()?.timezone, state.timeframe === '1D' || state.timeframe === '4h');
      ctx.fillText(label, left + plotW * i / 6, h - 8);
    }
  }

  function renderTab() {
    const content = $('#tabContent');
    const price = currentPrice();
    if (!Number.isFinite(price) || !state.candleData.length) {
      content.innerHTML = '<div class="levels-grid"><div class="level-item current-level"><span>MARKET DATA</span><strong class="mono">Waiting…</strong><small>Fetching Yahoo Finance bars</small></div></div>';
      return;
    }
    const unit = stepSize();
    if (state.activeTab === 'levels') {
      content.innerHTML = `
        <div class="levels-grid">
          <div class="level-item resistance"><span>RESISTANCE 2</span><strong class="mono">${money(price + unit * 3.5)}</strong><small>1.8 average ranges above R1</small></div>
          <div class="level-item resistance"><span>RESISTANCE 1</span><strong class="mono">${money(price + unit * 1.8)}</strong><small>Near-term reference</small></div>
          <div class="level-item current-level"><span>CURRENT PRICE</span><strong class="mono">${money(price)}</strong><small>Latest Yahoo chart value</small></div>
          <div class="level-item support"><span>SUPPORT 1</span><strong class="mono">${money(price - unit * 1.8)}</strong><small>Near-term reference</small></div>
          <div class="level-item support"><span>SUPPORT 2</span><strong class="mono">${money(price - unit * 3.5)}</strong><small>1.8 average ranges below S1</small></div>
        </div>`;
    } else if (state.activeTab === 'trade') {
      const bias = (currentMarket()?.changePercent ?? 0) >= 0 ? 1 : -1;
      content.innerHTML = `<div class="trade-plan-grid">
        <div class="plan-cell"><span>ENTRY ZONE</span><strong>${money(price - unit * 0.22)} – ${money(price + unit * 0.22)}</strong></div>
        <div class="plan-cell"><span>STOP LOSS (ILLUSTRATIVE)</span><strong style="color:#f17c89">${money(price - unit * 1.7 * bias)}</strong></div>
        <div class="plan-cell"><span>TARGET 1 (ILLUSTRATIVE)</span><strong style="color:#51d69e">${money(price + unit * 2 * bias)}</strong></div>
        <div class="plan-cell"><span>EMA 9</span><strong>${money(calculateEMA(state.candleData.map(c => c.close), 9).at(-1))}</strong></div>
      </div>`;
    } else {
      const rows = state.history.filter(item => item.symbol === state.symbol && item.interval === state.timeframe);
      content.innerHTML = rows.length
        ? `<div class="history-list">${rows.map(item => `<div class="history-row"><span class="history-time">${item.time}</span><strong>${item.verdict} · ${item.score}%</strong><span class="mono">${item.price}</span><span>${item.symbol} / ${item.interval}</span></div>`).join('')}</div>`
        : '<div class="history-list"><div class="history-row"><span>No local indicator snapshots yet.</span></div></div>';
    }
  }

  async function fetchMarketData({ force = false, quiet = true, analyze = false } = {}) {
    let loadedMarket = null;
    let shouldAnalyzeAfterLoad = false;
    const symbol = state.symbol;
    const timeframe = state.timeframe;
    const requestKey = `${symbol}:${timeframe}`;
    if (state.inflight.has(requestKey)) return null;
    state.inflight.add(requestKey);
    const providerInterval = timeframe === '4h' ? '1h' : timeframe === '1D' ? '1d' : timeframe;
    if (!quiet) setFeedStatus('CONNECTING TO YAHOO', `${symbol} · ${providerInterval} OHLCV`, 'loading');

    try {
      const url = `/api/market?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(providerInterval)}${force ? '&refresh=1' : ''}`;
      const response = await fetch(url, { cache: 'no-store', headers: { 'Accept': 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || payload.error || `Local data server returned HTTP ${response.status}`);
      if (symbol !== state.symbol || timeframe !== state.timeframe) return null;
      if (!Array.isArray(payload.bars) || !payload.bars.length) throw new Error('The provider returned no bars for this instrument.');

      const normalized = { ...payload, bars: visibleBars(payload.bars) };
      state.marketData[marketKey(symbol, timeframe)] = normalized;
      state.candleData = normalized.bars;
      state.marketDataRevision += 1;
      loadedMarket = normalized;
      state.lastError = null;
      updateAssetUI();
      updateAnalysis();
      renderTab();
      drawChart();
      const sourceState = payload.stale ? 'STALE CACHE' : 'YAHOO FINANCE DATA';
      const detail = payload.stale ? 'Last good response · upstream unavailable' : `${payload.interval} bars · refresh approx. ${POLL_SECONDS}s · may be delayed`;
      setFeedStatus(sourceState, detail, payload.stale ? 'stale' : 'ok');
      setText('#marketDataFootnote', payload.stale ? 'Showing the last cached provider response.' : 'Source: Yahoo Finance public chart endpoint · unofficial · delayed data possible.');
      if (!analyze || !state.lmStudio.enabled) {
        resetLmResult(state.lmStudio.enabled ? 'NEW DATA · MODEL NOT RUN' : 'LOCAL INDICATORS ONLY');
      }
      if (!quiet) showToast(`${symbol}: ${normalized.bars.length} ${timeframe} OHLCV bars loaded from Yahoo Finance.`);
      shouldAnalyzeAfterLoad = Boolean(analyze && state.lmStudio.enabled);
    } catch (error) {
      if (symbol !== state.symbol || timeframe !== state.timeframe) return null;
      state.lastError = error.message;
      const cachedMarket = state.marketData[marketKey(symbol, timeframe)];
      const hadCached = Array.isArray(cachedMarket?.bars) && cachedMarket.bars.length;
      setFeedStatus(hadCached ? 'DATA REFRESH FAILED' : 'DATA UNAVAILABLE', hadCached ? 'Showing prior downloaded bars' : 'See local server / network status', hadCached ? 'stale' : 'error');
      setText('#lastUpdated', hadCached ? 'Refresh failed · showing last downloaded bars' : 'No market data loaded');
      if (!hadCached) {
        state.candleData = [];
        updateAssetUI();
        drawChart();
        renderTab();
      }
      if (!quiet) showToast(`Market data request failed: ${error.message}`);
      else console.warn('Market data refresh failed:', error.message);
      return null;
    } finally {
      state.inflight.delete(requestKey);
    }
    if (shouldAnalyzeAfterLoad) void runLmStudioAnalysis();
    return loadedMarket;
  }

  function runAnalysis() {
    state.countdown = POLL_SECONDS;
    fetchMarketData({ force: true, quiet: false, analyze: state.lmStudio.enabled });
    $('#refreshButton').classList.add('is-spinning');
    setTimeout(() => $('#refreshButton')?.classList.remove('is-spinning'), 550);
  }

  function updateCountdownUI() {
    const value = String(state.countdown).padStart(2, '0');
    setText('#debateCountdown', `${value}s`);
    setText('#nextUpdate', value);
    setText('#miniCountdown', value);
  }

  function initEvents() {
    $$('.timeframe').forEach(button => button.addEventListener('click', () => {
      state.timeframe = button.dataset.timeframe;
      state.lmStudio.lastAnalysisKey = null;
      resetLmResult(state.lmStudio.enabled ? 'NEW TIMEFRAME · MODEL NOT RUN' : 'LOCAL INDICATORS ONLY');
      $$('.timeframe').forEach(item => item.classList.toggle('active', item === button));
      state.candleData = visibleBars(currentMarket()?.bars || []);
      updateAssetUI();
      updateAnalysis();
      renderTab();
      drawChart();
      state.countdown = POLL_SECONDS;
      fetchMarketData({ force: true, quiet: false, analyze: state.lmStudio.enabled && state.lmStudio.autoAnalyze });
    }));
    $$('.detail-tab').forEach(button => button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab;
      $$('.detail-tab').forEach(item => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderTab();
    }));

    $('#symbolSearch').addEventListener('input', event => {
      const query = event.target.value.trim();
      const requestId = ++state.searchRequestId;
      clearTimeout(state.searchTimer);
      if (!query) {
        renderAssetList();
        return;
      }
      state.searchTimer = setTimeout(() => searchStocks(query, requestId), 280);
    });

    $('#candlesButton').addEventListener('click', () => {
      state.showCandles = !state.showCandles;
      $('#candlesButton').classList.toggle('active', state.showCandles);
      drawChart();
      showToast(state.showCandles ? 'Candlestick bodies enabled' : 'Candlestick bodies hidden');
    });
    $('#levelsButton').addEventListener('click', () => {
      state.showLevels = !state.showLevels;
      $('#levelsButton').classList.toggle('active', state.showLevels);
      drawChart();
      showToast(state.showLevels ? 'Support and resistance enabled' : 'Support and resistance hidden');
    });
    $('#refreshButton').addEventListener('click', runAnalysis);
    $('#pauseButton').addEventListener('click', () => {
      state.paused = !state.paused;
      $('#pauseButton').textContent = state.paused ? '▶ Resume feed' : 'Ⅱ Pause feed';
      $('#pauseButton').classList.toggle('paused', state.paused);
      showToast(state.paused ? 'Automatic market-data polling paused' : 'Automatic market-data polling resumed');
    });
    $('#dismissNotice').addEventListener('click', () => $('.demo-notice')?.remove());
    $('#fullscreenButton').addEventListener('click', () => {
      const panel = $('.chart-panel');
      panel.classList.toggle('expanded');
      $('#fullscreenButton').innerHTML = panel.classList.contains('expanded') ? '<span>×</span>' : '<span>⛶</span>';
      setTimeout(drawChart, 80);
    });
    $('#manageWatchlist').addEventListener('click', () => showToast('Search NYSE/Nasdaq stocks or cryptocurrencies and select one to add it to this watchlist.'));
    $('#settingsButton').addEventListener('click', openSettingsModal);
    $('#helpButton').addEventListener('click', openModal);
    $('#profileButton').addEventListener('click', openModal);
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalOk').addEventListener('click', closeModal);
    $('#modalBackdrop').addEventListener('click', event => { if (event.target === $('#modalBackdrop')) closeModal(); });
    $('#lmSettingsClose').addEventListener('click', closeSettingsModal);
    $('#lmSettingsBackdrop').addEventListener('click', event => { if (event.target === $('#lmSettingsBackdrop')) closeSettingsModal(); });
    $('#lmLoadModels').addEventListener('click', loadLmModels);
    $('#lmTestConnection').addEventListener('click', testLmStudioConnection);
    $('#lmSaveSettings').addEventListener('click', saveLmStudioSettings);
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#symbolSearch').focus(); }
      if (event.key === 'Escape') {
        closeModal();
        closeSettingsModal();
        if ($('.chart-panel').classList.contains('expanded')) {
          $('.chart-panel').classList.remove('expanded');
          setTimeout(drawChart, 80);
        }
      }
    });

    const canvas = $('#marketChart');
    canvas.addEventListener('mousemove', event => {
      if (!state.candleData.length) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const vertical = $('#crosshairV'), horizontal = $('#crosshairH'), tooltip = $('#chartTooltip');
      vertical.style.display = horizontal.style.display = tooltip.style.display = 'block';
      vertical.style.left = `${x}px`; horizontal.style.top = `${y}px`;
      const index = Math.max(0, Math.min(state.candleData.length - 1, Math.floor((x - 12) / (rect.width - 92) * state.candleData.length)));
      const candle = state.candleData[index];
      if (candle) {
        tooltip.textContent = `${formatBarTime(candle.time, currentMarket()?.timezone, true)}  O ${money(candle.open)} H ${money(candle.high)} L ${money(candle.low)} C ${money(candle.close)}`;
        tooltip.style.left = `${Math.max(10, Math.min(x + 12, rect.width - 270))}px`;
        tooltip.style.top = `${Math.max(8, y - 30)}px`;
      }
    });
    canvas.addEventListener('mouseleave', () => {
      $('#crosshairV').style.display = $('#crosshairH').style.display = $('#chartTooltip').style.display = 'none';
    });
  }

  function openModal() { $('#modalBackdrop').hidden = false; }
  function closeModal() { $('#modalBackdrop').hidden = true; }
  function openSettingsModal() { populateLmSettingsForm(); $('#lmSettingsBackdrop').hidden = false; }
  function closeSettingsModal() { $('#lmSettingsBackdrop').hidden = true; }

  function startClock() {
    setInterval(() => {
      if (state.paused) return;
      state.countdown -= 1;
      if (state.countdown <= 0) {
        state.countdown = POLL_SECONDS;
        fetchMarketData({ quiet: true, analyze: state.lmStudio.enabled && state.lmStudio.autoAnalyze });
      }
      updateCountdownUI();
    }, 1000);
  }

  function init() {
    renderAssetList();
    updateAssetUI();
    updateAnalysis();
    updateCountdownUI();
    initEvents();
    renderTab();
    drawChart();
    setFeedStatus('CONNECTING TO YAHOO', 'Requesting 5-minute U.S. equity OHLCV bars', 'loading');
    fetchMarketData({ force: true, quiet: false, analyze: state.lmStudio.enabled && state.lmStudio.autoAnalyze });
    if (state.lmStudio.enabled) setLmResultStatus('LM STUDIO CONFIGURED');
    startClock();
    setInterval(refreshWatchlistQuotes, 60_000);
    window.addEventListener('resize', drawChart);
    if (document.fonts?.ready) document.fonts.ready.then(drawChart);
  }

  init();
})();
