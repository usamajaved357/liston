// A CSV file a spreadsheet opens as it is: a UTF-8 byte-order mark (so Excel
// reads £ and accents right), CRLF lines, a cell quoted when it holds a
// comma, quote or line break, and text that would start a formula (= + - @
// tab, return) led with an apostrophe so a cell can never run as one.
// Empty for null, undefined and non-finite numbers. Pure.

const FORMULA = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header, rows) {
  return `﻿${[header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { toCsv, cell };
