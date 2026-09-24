"use client";

// A CSV file built in the browser from figures already on screen — no
// request, no eBay call. Opens cleanly in Excel (UTF-8 marker, CRLF rows)
// and Google Sheets. Text cells that a spreadsheet would run as a formula
// (starting with = + - @) are prefixed with ' so a listing title can't.

export type CsvCell = string | number | null | undefined;

function cell(value: CsvCell): string {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "Walexo Ltd." → "walexo-ltd", for file names. */
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "export";

/** 0.1234 → 12.34 (a percentage for a spreadsheet column), null stays empty. */
export const pct = (fraction: number | null | undefined, digits = 2) => (fraction == null || !Number.isFinite(fraction) ? null : Math.round(fraction * 100 * 10 ** digits) / 10 ** digits);
