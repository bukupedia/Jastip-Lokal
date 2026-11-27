/* ============================================================================
 * js/config.js — configuration + shared, side-effect-free helpers
 * Loaded before js/app.js. Exposes globals: CONFIG, isConfigReady,
 * escapeHTML, formatRupiah, formatDateTimeId, formatRelativeDays,
 * safeImageUrl, clampInt, debounce.
 * ==========================================================================*/

'use strict';

/* ----------------------------------------------------------------------------
 * 1. Configuration
 *    Fill these two values from Supabase Dashboard -> Project Settings -> API.
 *    ONLY the anon key belongs here. The service_role key must never be
 *    shipped to the browser: it bypasses Row Level Security.
 * ------------------------------------------------------------------------- */
const CONFIG = Object.freeze({
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-KEY',

  TRIP_SETTINGS_ID: 1,

  CART_STORAGE_KEY: 'jastip.cart.v1',
  SEARCH_DEBOUNCE_MS: 250,
  MAX_QTY_PER_ITEM: 99,
  SKELETON_COUNT: 8,

  CURRENCY_LOCALE: 'id-ID',
  TIMEZONE: 'Asia/Jakarta',
});

const CATEGORIES = Object.freeze([
  { value: 'all', label: 'Semua' },
  { value: 'Kuliner', label: 'Kuliner' },
  { value: 'Oleh-oleh', label: 'Oleh-oleh' },
  { value: 'Fashion', label: 'Fashion' },
  { value: 'Kerajinan', label: 'Kerajinan' },
]);

/**
 * True when the placeholders above have been replaced with real values.
 * @returns {boolean}
 */
function isConfigReady() {
  const url = String(CONFIG.SUPABASE_URL ?? '');
  const key = String(CONFIG.SUPABASE_ANON_KEY ?? '');
  return (
    /^https:\/\/[^\s]+$/i.test(url) &&
    !url.includes('YOUR-PROJECT-REF') &&
    key.length > 40 &&
    !key.startsWith('YOUR-')
  );
}

/* ----------------------------------------------------------------------------
 * 2. XSS sanitisation
 *    The storefront inserts every dynamic value with textContent, so it never
 *    needs this helper. It exists for code paths that must interpolate a value
 *    into an HTML string (the Phase 3 admin panel, printable receipts, etc.).
 *    Rule of thumb: if you reach for innerHTML, wrap every value in escapeHTML.
 * ------------------------------------------------------------------------- */
const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
});

/**
 * Escapes a value so it is safe to place inside HTML text or a quoted attribute.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (char) => HTML_ESCAPES[char]);
}

/* ----------------------------------------------------------------------------
 * 3. Formatting helpers (integer Rupiah only — no floating point money)
 * ------------------------------------------------------------------------- */
const rupiahFormatter = new Intl.NumberFormat(CONFIG.CURRENCY_LOCALE, {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Formats a whole-rupiah amount, e.g. 65000 -> "Rp 65.000".
 * Non-numeric input degrades to "Rp 0" instead of "Rp NaN".
 * @param {unknown} value
 * @returns {string}
 */
function formatRupiah(value) {
  const numeric = Number(value);
  const amount = Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  return rupiahFormatter.format(amount);
}

const dateTimeFormatter = new Intl.DateTimeFormat(CONFIG.CURRENCY_LOCALE, {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: CONFIG.TIMEZONE,
});

const dateFormatter = new Intl.DateTimeFormat(CONFIG.CURRENCY_LOCALE, {
  dateStyle: 'medium',
  timeZone: CONFIG.TIMEZONE,
});

/**
 * @param {string|number|Date|null|undefined} value
 * @param {{ withTime?: boolean }} [options]
 * @returns {string} e.g. "12 Des 2026, 20.00 WIB" or "—" when invalid
 */
function formatDateTimeId(value, options = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const formatter = options.withTime === false ? dateFormatter : dateTimeFormatter;
  return `${formatter.format(date)}${options.withTime === false ? '' : ' WIB'}`;
}

/**
 * Human-friendly distance to a deadline, e.g. "Tersisa 3 hari".
 * @param {string|number|Date|null|undefined} value
 * @returns {string}
 */
function formatRelativeDays(value) {
  if (!value) return '';
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return '';

  const dayMs = 86_400_000;
  const diff = target - Date.now();
  if (diff <= 0) return 'Sudah berakhir';

  const days = Math.floor(diff / dayMs);
  if (days === 0) return 'Berakhir hari ini';
  if (days === 1) return 'Tersisa 1 hari';
  return `Tersisa ${days} hari`;
}

/**
 * Allows only http(s) image sources. Blocks javascript:, data:, and garbage.
 * @param {unknown} value
 * @returns {string} empty string when the URL is unusable
 */
function safeImageUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, window.location.href);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch (error) {
    /* malformed URL — fall through to the placeholder */
  }
  return '';
}

/**
 * Normalises an Indonesian phone number to the wa.me format (62…, digits only).
 * "0812-3456-7890" -> "6281234567890"
 * @param {unknown} value
 * @returns {string} empty string when there is nothing usable
 */
function normalizePhoneId(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith('8')) digits = `62${digits}`;
  return digits;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number} integer clamped to [min, max]
 */
function clampInt(value, min, max) {
  const numeric = Number(value);
  const int = Number.isFinite(numeric) ? Math.trunc(numeric) : min;
  return Math.min(Math.max(int, min), max);
}

/**
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} waitMs
 * @returns {(...args: Parameters<F>) => void}
 */
function debounce(fn, waitMs) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}
