'use strict';
// Optional Claude-powered helpers. Every function takes the user's API key and
// is only called when one is configured; the app works without them.

const { CATEGORIES } = require('./categories');

const MODEL = 'claude-haiku-4-5-20251001';

let _Anthropic;
function client(apiKey) {
  if (!_Anthropic) _Anthropic = require('@anthropic-ai/sdk');
  return new _Anthropic({ apiKey });
}

const VALID_CATEGORIES = CATEGORIES;

// System prompt is static → cached across all calls (prefix cache)
const AI_SYSTEM = `You are a credit card transaction categorizer and merchant name normalizer.

Merchants may be from any country. Israeli merchants often appear transliterated from Hebrew (e.g., SHUFERSAL, RAMI LEVY, SUPER-PHARM, AROMA ESPRESSO, COFIX, PAZ). Use your training knowledge to identify merchants — assign lower confidence (below 0.60) when genuinely uncertain.

Normalize merchant names: remove payment processor prefixes (SQ *, TST*, PAYPAL *, APL *), transaction IDs (* followed by codes like *AB12C3), store numbers (#1234), legal suffixes (LLC, INC), US state codes at the end, and expand abbreviations to readable brand names (WHOLEFDS → Whole Foods, AMZN MKTP → Amazon, WAL-MART → Walmart).

Use EXACTLY these category names (copy them verbatim):
${VALID_CATEGORIES.join(' | ')}

Confidence guide: 0.95+ obvious brand (Netflix, Shell, Walmart) · 0.80-0.94 clear type (Hair Salon, Gym) · 0.60-0.79 educated guess · below 0.60 uncertain

Return a JSON array, one object per merchant:
[{"merchant":"<exact input name>","normalized":"<clean human-readable name>","category":"<category>","confidence":<0.0-1.0>}, ...]

No markdown, no code fences, no explanation.`;

function getApiKey() {
  return (loadJSON(SETTINGS_FILE, {})).anthropicApiKey || null;
}

function parseLocationForSearch(locationStr) {
  if (!locationStr || typeof locationStr !== 'string') return null;
  const city = locationStr.split(',')[0].trim();
  if (!city) return null;
  return { type: 'approximate', city };
}

function extractJsonObjects(text) {
  // Try full array parse first
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  // Fallback: pull out each valid object individually (handles truncated arrays)
  const results = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try { results.push(JSON.parse(m[0])); } catch {}
  }
  return results;
}

async function aiCategorizeBatch(batch, client) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Categorize these ${batch.length} merchants:\n${batch.map((m,i) => `${i+1}. "${m}"`).join('\n')}\n\nReturn a JSON array with ${batch.length} objects.`,
    }],
  });
  const allText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJsonObjects(allText);
}

async function aiCategorizeMerchants(merchants, apiKey) {
  const client = client(apiKey);

  // Deduplicate by normalized name so we don't send the same merchant twice
  const seen = new Map(); // normalizedKey → original merchant string
  for (const m of merchants) {
    const key = m.toLowerCase().trim();
    if (!seen.has(key)) seen.set(key, m);
  }
  const dedupedList = [...seen.values()];

  const BATCH_SIZE = 25;
  const batches = [];
  for (let i = 0; i < dedupedList.length; i += BATCH_SIZE) {
    batches.push(dedupedList.slice(i, i + BATCH_SIZE));
  }

  // Run all batches in parallel
  const batchResults = await Promise.all(batches.map(b => aiCategorizeBatch(b, client).catch(() => [])));
  const rawResults = batchResults.flat();

  if (!rawResults.length) throw new Error('AI returned no parseable results');

  const cleaned = rawResults.map(r => ({
    merchant: r.merchant,
    normalized: (r.normalized || r.merchant).trim(),
    category: VALID_CATEGORIES.includes(r.category) ? r.category : 'Other',
    confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
  }));

  // Fan results back out to all original duplicates
  const resultByKey = new Map(cleaned.map(r => [r.merchant.toLowerCase().trim(), r]));
  return merchants.map(m => resultByKey.get(m.toLowerCase().trim()) || {
    merchant: m, normalized: m, category: 'Other', confidence: 0,
  });
}

async function aiTextToCategory(text, merchant, apiKey) {
  const client = client(apiKey);
  const prompt = merchant
    ? `Merchant: "${merchant}" · User says: "${text}" → category?`
    : `User says: "${text}" → spending category?`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 32,
    system: [{ type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });

  const cat = response.content[0].text.trim();
  return VALID_CATEGORIES.includes(cat) ? cat : null;
}

// ---- Merchant identification (with web search) ----
async function identifyMerchant({ merchant, rawMerchant, location }, apiKey) {
  const userLocation = parseLocationForSearch(location);
  const webSearchTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
    ...(userLocation && { user_location: userLocation }),
  };
  // Strip quotes/newlines so a merchant string can't break out of the prompt
  const safeMerchant = String(merchant).replace(/["\n\r]/g, ' ').trim().slice(0, 200);
  const safeRaw = rawMerchant ? String(rawMerchant).replace(/["\n\r]/g, ' ').trim().slice(0, 200) : '';
  const prompt = `A credit card statement shows this merchant: "${safeMerchant}"${safeRaw && safeRaw !== safeMerchant ? ` (raw bank string: "${safeRaw}")` : ''}.

Identify what this business actually is. Search the web if needed. Return JSON only:
{"name":"<clean readable business name>","category":"<one of the valid categories>","description":"<1 sentence: what this business is>","confidence":<0.0-1.0>}

Valid categories: ${VALID_CATEGORIES.join(' | ')}`;

  const response = await client(apiKey).messages.create({
    model: MODEL,
    max_tokens: 300,
    system: [{ type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
    tools: [webSearchTool],
  });
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse result');
  const result = JSON.parse(match[0]);
  return {
    name: (result.name || merchant).trim(),
    category: VALID_CATEGORIES.includes(result.category) ? result.category : 'Other',
    description: result.description || '',
    confidence: Math.min(1, Math.max(0, Number(result.confidence) || 0)),
  };
}

// ---- Spending insight (dashboard) ----
async function spendingInsight({ periodLabel, total, priorContext, count, topCats, topTxn }, apiKey) {
  const prompt = `Spending summary for ${periodLabel}:
Total: $${total.toFixed(2)}${priorContext} across ${count} transactions
Top categories: ${topCats}
Largest charge: $${topTxn.amount.toFixed(2)} at ${topTxn.merchant}

Write 2-3 sentences of friendly, specific financial insight. Mention what stands out, any notable patterns, or one practical observation. Be conversational, not robotic. No bullet points or headers.`;
  const response = await client(apiKey).messages.create({
    model: MODEL,
    max_tokens: 200,
    system: [{ type: 'text', text: 'You are a friendly personal finance assistant. Give short, specific, helpful spending insights in 2-3 natural sentences. No bullet points, no headers, no filler phrases like "Great news!"', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text.trim();
}

// ---- Budget insight ----
async function budgetInsight({ monthLabel, totalSpent, monthlyBudget, categories, totalIncome, manualExpenses }, apiKey) {
  const catLines = (categories || []).map(c => `  ${c.name}: $${c.spent.toFixed(0)}${c.budget ? ` (limit $${c.budget}, ${c.spent > c.budget ? 'OVER' : 'ok'})` : ''}`).join('\n');
  const expLines = (manualExpenses || []).map(e => `  ${e.label}: $${e.amount.toFixed(0)}`).join('\n');
  const parts = [
    totalIncome   ? `Income: $${totalIncome.toFixed(0)}` : '',
    expLines      ? `Fixed expenses (rent, etc.):\n${expLines}` : '',
    `Credit card spending: $${totalSpent.toFixed(0)}`,
    monthlyBudget ? `Monthly spend target: $${monthlyBudget}` : '',
    catLines      ? `Credit card breakdown:\n${catLines}` : '',
  ].filter(Boolean).join('\n');
  const systemPrompt = `Talk like a smart friend who knows money well — direct, warm, and specific. Use the actual dollar numbers. Skip filler like "Great job!" or "It's important to budget." If something looks good, just say so plainly. If something looks off, say exactly what and why. Give one concrete, specific thing they could do differently. 2-3 sentences max. No bullet points.`;
  const msg = await client(apiKey).messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: 'user', content: `${systemPrompt}\n\n${monthLabel} finances:\n${parts}` }],
  });
  return msg.content[0]?.text?.trim() || null;
}

// ---- Budget suggestions ----
async function suggestBudgets(catSummary, numMonths, apiKey) {
  const lines = Object.entries(catSummary)
    .map(([cat, { avg, max, months }]) => `${cat}: avg $${avg}/mo, max $${max}, present in ${months}/${numMonths} months`)
    .join('\n');
  const msg = await client(apiKey).messages.create({
    model: MODEL,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Based on spending history (${numMonths} months of data), suggest realistic monthly budget limits per category. Be slightly generous (a buffer above typical spend) but not wasteful. Round to nearest $25. Return ONLY valid JSON object like {"Groceries":400,"Dining":200}. Categories:\n${lines}`,
    }],
  });
  const raw = msg.content[0]?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  const parsed = JSON.parse(jsonMatch[0]);
  const suggestions = {};
  for (const [cat, val] of Object.entries(parsed)) {
    if (catSummary[cat] && typeof val === 'number' && val > 0) suggestions[cat] = val;
  }
  return suggestions;
}

// ---- Merchant de-duplication ----
async function dedupeMerchants(uniqueNames, apiKey) {
  const prompt = `You are cleaning up merchant names from credit card statements. Here is the complete list of ${uniqueNames.length} unique merchant names currently in the database:

${JSON.stringify(uniqueNames, null, 2)}

Your job: identify names that are clearly the same merchant but appear as duplicates due to typos, truncation, extra location suffixes, or slight spelling differences. Also clean up names that still have junk in them (reference codes, payment processor prefixes, garbage suffixes).

Return ONLY a JSON object mapping each name-to-change to its canonical target name. Example format:
{"Aris Baker": "Aris Bakery", "Krispykreme": "Krispy Kreme"}

Rules:
- Only include names you are CONFIDENT about
- The target (canonical) name should be another name already in the list when possible, or a clean version of it
- Do NOT merge merchants that are genuinely different places (e.g. different branches are ok to merge if the name is clearly the same merchant)
- Do NOT touch names that are already clean and unambiguous
- Strip trailing city names only when the merchant clearly exists without it (e.g. if both "Katzefet" and "Katzefet Ramat Eshko" exist, map the longer one to "Katzefet")
- For Amazon sub-entries (Amazon Mark*, Amazon Mktpl, Amazon Reta*) → map to "Amazon"
- For reference codes still embedded → strip them
- Be conservative: when in doubt, leave it alone

Respond with ONLY the JSON object, no explanation.`;
  const message = await client(apiKey).messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = message.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : {};
}

module.exports = {
  MODEL, AI_SYSTEM,
  categorizeMerchants: aiCategorizeMerchants,
  textToCategory: aiTextToCategory,
  identifyMerchant, spendingInsight, budgetInsight, suggestBudgets, dedupeMerchants,
};
