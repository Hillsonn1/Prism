'use strict';
// Shared plumbing for the Claude-powered features: one client per key, the
// models each job uses, the web-search tool, and a running tally of usage so
// Settings can show what the key has cost this month.

const MODELS = {
  assistant: 'claude-opus-5',            // Ask Prism: reasoning over the ledger with tools
  assistantFast: 'claude-sonnet-5',      // the cheaper choice in Settings
  vision: 'claude-sonnet-5',             // statements, screenshots and receipts
  review: 'claude-sonnet-5',             // category review with reasons
  enrich: 'claude-haiku-4-5-20251001',   // merchant intelligence, knowledge pass
  lookup: 'claude-sonnet-5',             // merchant intelligence with web search
};

// Rough list prices per million tokens; the Settings figure is an estimate
const PRICES = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};
const WEB_SEARCH_PER_1000 = 10;

function estimateUsd(model, usage) {
  const p = PRICES[model] || PRICES['claude-sonnet-5'];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (input * p.input + (usage.output_tokens || 0) * p.output) / 1e6 + searches * WEB_SEARCH_PER_1000 / 1000;
}

function createClaude({ store, apiKey, log = console }) {
  let _Anthropic;
  let cached = { key: null, client: null };
  function client() {
    const key = apiKey();
    if (!key) throw Object.assign(new Error('Add an Anthropic API key in Settings to use this'), { status: 400 });
    if (cached.key !== key) {
      if (!_Anthropic) _Anthropic = require('@anthropic-ai/sdk');
      // PRISM_ANTHROPIC_HOST points the SDK at a local mock (scripts/mock-anthropic.js)
      cached = { key, client: new _Anthropic({ apiKey: key, maxRetries: 2, ...(process.env.PRISM_ANTHROPIC_HOST ? { baseURL: process.env.PRISM_ANTHROPIC_HOST } : {}) }) };
    }
    return cached.client;
  }

  const available = () => Boolean(apiKey());

  // The model the assistant uses is a Settings choice; everything else is fixed
  function model(job) {
    if (job === 'assistant') return store.read('settings').prefs?.assistantModel === 'fast' ? MODELS.assistantFast : MODELS.assistant;
    return MODELS[job];
  }

  // Web search, biased to where the user is; Haiku 4.5 only speaks the older tool version
  function webSearchTool(forModel, { maxUses = 2 } = {}) {
    const location = String(store.read('settings').location || '').split(',')[0].trim();
    return {
      type: forModel.startsWith('claude-haiku-4-5') ? 'web_search_20250305' : 'web_search_20260209',
      name: 'web_search',
      max_uses: maxUses,
      ...(location ? { user_location: { type: 'approximate', city: location } } : {}),
    };
  }

  // Tally tokens per month and feature (settings.aiUsage)
  function record(feature, forModel, usage) {
    if (!usage) return;
    const month = new Date().toISOString().slice(0, 7);
    const usd = estimateUsd(forModel, usage);
    store.update('settings', s => {
      const all = (s.aiUsage = s.aiUsage || {});
      const m = (all[month] = all[month] || { calls: 0, input: 0, output: 0, cacheRead: 0, searches: 0, usd: 0, features: {} });
      m.calls++;
      m.input += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      m.output += usage.output_tokens || 0;
      m.cacheRead += usage.cache_read_input_tokens || 0;
      m.searches += usage.server_tool_use?.web_search_requests || 0;
      m.usd = Math.round((m.usd + usd) * 10000) / 10000;
      const f = (m.features[feature] = m.features[feature] || { calls: 0, usd: 0 });
      f.calls++;
      f.usd = Math.round((f.usd + usd) * 10000) / 10000;
    });
  }

  function usageThisMonth() {
    const month = new Date().toISOString().slice(0, 7);
    return store.read('settings').aiUsage?.[month] || { calls: 0, input: 0, output: 0, cacheRead: 0, searches: 0, usd: 0, features: {} };
  }

  // The text of a response, ignoring tool and thinking blocks
  const textOf = message => (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  // The input of the first tool_use block with this name
  const toolInput = (message, name) => (message.content || []).find(b => b.type === 'tool_use' && b.name === name)?.input || null;

  return { client, available, model, webSearchTool, record, usageThisMonth, textOf, toolInput, MODELS, estimateUsd };
}

module.exports = { createClaude, MODELS, estimateUsd };
