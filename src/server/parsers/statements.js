'use strict';
// Statement parsing: CSV (any bank with date/description/amount columns) and
// best-effort PDF. Both return [{ date: 'YYYY-MM-DD', merchant, amount, csvCategory? }]
// with charges positive and credits negative, payments already filtered out.

const { isPayment } = require('../categories');

// Minimal CSV parser (handles quoted fields with embedded commas and doubled quotes)
function parseCSVRows(text) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const parseLine = line => {
    const fields = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let f = ''; i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { f += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else f += line[i++];
        }
        fields.push(f);
        if (line[i] === ',') i++;
      } else {
        const end = line.indexOf(',', i);
        if (end === -1) { fields.push(line.slice(i).trim()); break; }
        fields.push(line.slice(i, end).trim());
        i = end + 1;
      }
    }
    return fields;
  };
  const nonEmpty = lines.filter(l => l.trim());
  if (!nonEmpty.length) return [];
  const headers = parseLine(nonEmpty[0]);
  return nonEmpty.slice(1).map(line => {
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  }).filter(r => Object.values(r).some(v => v));
}

function findColumn(headers, candidates) {
  for (const c of candidates) {
    const found = headers.find(h => h.toLowerCase().trim() === c.toLowerCase());
    if (found) return found;
  }
  return null;
}

function parseAmount(str) {
  if (!str && str !== 0) return null;
  const n = parseFloat(String(str).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

function normalizeDate(str) {
  if (!str) return null;
  const s = str.trim();

  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    const year = y.length === 2 ? '20' + y : y;
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // MM/DD (no year)
  const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) {
    const year = new Date().getFullYear();
    return `${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
  }

  // "Jan 15, 2024" or "January 15, 2024"
  const named = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) {
    const mon = MONTHS[named[1].slice(0,3).toLowerCase()];
    if (mon) return `${named[3]}-${String(mon).padStart(2,'0')}-${named[2].padStart(2,'0')}`;
  }

  // "15 Jan 2024"
  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (dmy) {
    const mon = MONTHS[dmy[2].slice(0,3).toLowerCase()];
    if (mon) return `${dmy[3]}-${String(mon).padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
  }

  // "Jan 15" (no year)
  const namedNoYear = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/);
  if (namedNoYear) {
    const mon = MONTHS[namedNoYear[1].slice(0,3).toLowerCase()];
    if (mon) return `${new Date().getFullYear()}-${String(mon).padStart(2,'0')}-${namedNoYear[2].padStart(2,'0')}`;
  }

  return s;
}

function parseCSV(content) {
  let records;
  try {
    records = parseCSVRows(content);
  } catch (e) {
    throw new Error('Could not parse CSV file: ' + e.message);
  }

  if (!records.length) return [];

  const headers = Object.keys(records[0]);

  const dateKey = findColumn(headers, ['Transaction Date', 'Date', 'Posted Date', 'Post Date', 'Trans Date', 'Posting Date']);
  const descKey = findColumn(headers, ['Description', 'Payee', 'Merchant Name', 'Name', 'Original Description', 'Merchant', 'Transaction Description']);
  const amountKey = findColumn(headers, ['Amount', 'Transaction Amount', 'Charge Amount']);
  const debitKey = findColumn(headers, ['Debit', 'Debit Amount', 'Withdrawal']);
  const creditKey = findColumn(headers, ['Credit', 'Credit Amount', 'Deposit', 'Payment Amount']);
  const typeKey = findColumn(headers, ['Type', 'Transaction Type']);
  const categoryKey = findColumn(headers, ['Category', 'Transaction Category', 'Merchant Category', 'Spending Category', 'Expense Category']);

  if (!dateKey || !descKey) {
    throw new Error(
      `Could not detect CSV format. Columns found: ${headers.join(', ')}. ` +
      `Expected columns like "Date", "Description", and "Amount".`
    );
  }


  const rawAmounts = [];
  const transactions = [];

  for (const r of records) {
    // Skip card payments by Type column (e.g. Chase)
    if (typeKey) {
      const txType = (r[typeKey] || '').trim().toLowerCase();
      if (['payment', 'credit payment', 'autopay', 'transfer'].includes(txType)) continue;
    }

    const date = normalizeDate(r[dateKey]);
    const merchant = r[descKey]?.trim();
    if (!date || !merchant) continue;

    // Skip bill payments detected by description (catches banks without a Type column)
    if (isPayment(merchant)) continue;

    let amount = null;

    if (amountKey) {
      const raw = parseAmount(r[amountKey]);
      if (raw !== null) { amount = raw; rawAmounts.push(raw); }
    } else if (debitKey || creditKey) {
      const debit = parseAmount(r[debitKey]);
      const credit = parseAmount(r[creditKey]);
      if (debit && debit > 0) amount = debit;
      else if (credit && credit > 0) amount = -credit; // credits = negative
    }

    if (amount === null || amount === 0) continue;

    transactions.push({ date, merchant, amount: parseFloat(amount.toFixed(2)), csvCategory: categoryKey ? (r[categoryKey] || '').trim() : null });
  }

  // Chase-style CSVs store charges as negative numbers.
  // If the majority of amounts are negative, flip all signs so
  // expenses are positive and refunds/credits are negative.
  if (amountKey && rawAmounts.length > 0) {
    const negCount = rawAmounts.filter(a => a < 0).length;
    if (negCount > rawAmounts.length / 2) {
      transactions.forEach(t => { t.amount = parseFloat((-t.amount).toFixed(2)); });
    }
  }

  return transactions;
}

async function parsePDF(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return parseStatementText(data.text);
}

// Extracts transactions from statement text, one per line
function parseStatementText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  // Each pattern: [fullMatch, dateGroup, merchantGroup, amountGroup]
  const patterns = [
    // MM/DD/YYYY  MERCHANT  $XX.XX  (or without $)
    /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/,
    // MM/DD  MERCHANT  XX.XX
    /^(\d{1,2}\/\d{1,2})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/,
    // Jan 15, 2024  MERCHANT  $XX.XX  (Capital One style)
    /^([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/,
    // Jan 15  MERCHANT  $XX.XX  (Capital One without year)
    /^([A-Za-z]{3,9}\.?\s+\d{1,2})\s{2,}(.+?)\s{2,}\$?([\d,]+\.\d{2})\s*$/,
    // YYYY-MM-DD  MERCHANT  XX.XX
    /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
    // Looser single-space versions for tightly packed PDFs
    /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
    /^(\d{1,2}\/\d{1,2})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
    /^([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
    /^([A-Za-z]{3,9}\.?\s+\d{1,2})\s+(.+?)\s+\$?([\d,]+\.\d{2})\s*$/,
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      const m = line.match(pattern);
      if (m) {
        const date = normalizeDate(m[1]);
        // Strip leading posting dates (some banks include two dates before the merchant)
        // and trailing dates/locations. Loop handles multiple leading dates.
        let merchant = m[2].trim();
        let _prev;
        do {
          _prev = merchant;
          merchant = merchant
            .replace(/^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\s+/i, '')
            .replace(/^[A-Za-z]{3,9}\.?\s+\d{1,2}\s+/i, '')
            .replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s+/, '')
            .replace(/^\d{1,2}\/\d{1,2}\s+/, '')
            .replace(/\s+\d{1,2}\/\d{1,2}\/?\d{0,4}\s*$/, '')
            .replace(/\s+[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\s*$/, '')
            .trim();
        } while (merchant !== _prev && merchant.length > 0);
        const amount = parseFloat(m[3].replace(/,/g, ''));
        if (date && merchant && !isNaN(amount) && amount > 0) {
          transactions.push({ date, merchant, amount: parseFloat(amount.toFixed(2)) });
        }
        break;
      }
    }
  }

  return transactions;
}

async function pdfText(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer);
  return data.text;
}

module.exports = { parseCSVRows, parseCSV, parsePDF, parseStatementText, pdfText, findColumn, parseAmount, normalizeDate };
