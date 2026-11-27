# Changelog

All notable changes to **Jastip Lokal Indonesia** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions track the build phases: the minor number moves when a phase lands, and
`0.x` means the site is not yet deployed against a production Supabase project.

## [Unreleased]

### Added

- Nothing pending — see *Not yet done* below for known gaps.

### Not yet done

- `js/config.js` still ships placeholder values (`YOUR-PROJECT-REF`,
  `YOUR-SUPABASE-ANON-KEY`). The site shows a configuration notice until they
  are filled with the real project URL and anon key.
- `feat/phase1-supabase-schema-rls` has not been merged into `main`, and GitHub
  Pages is not enabled yet.
- No automated test suite is committed. Each phase was verified manually in a
  headless browser against a mocked Supabase client, and Phase 1 was verified
  against PostgreSQL 17 with `anon` / `authenticated` roles.

## [0.4.0] — 2026-11-27

Phase 4: authenticated admin panel and deployment documentation.
Commit [`e370e9b`](https://github.com/bukupedia/Jastip-Lokal/commit/e370e9b) ·
`admin.html` (430 lines), `js/admin.js` (1158 lines).

### Added

- `admin.html`: login card, tabbed dashboard (Trip / Produk / Pesanan),
  skip link, `boot` / `config` / `auth` / `app` phase switching, password
  reveal, sign-out.
- `js/admin.js`: `AdminApi`, `AdminStore`, `AdminUI`, `AdminApp` modules — the
  same four-module split as the storefront, so both entry points read alike.
- Trip settings editor: destination city, DP percentage, PO close date, ETA,
  admin WhatsApp, open/closed switch, plus a "last saved" timestamp.
- Product CRUD: create and edit form, category select, integer price and jastip
  fee, quota, optional image URL, per-row quota badges (rose at 0, amber below
  5) and a live product/quota count.
- Orders panel: newest-first list with collapsible item details, totals, DP and
  remaining balance, per-order WhatsApp button whose message text adapts to the
  current status, a one-click "next step" button, and a badge on the tab showing
  the number of orders awaiting DP.
- `README.md`: Supabase setup, frontend configuration, local server, GitHub
  Pages deployment, ordering flow and admin workflow.

### Changed

- Product delete uses a two-step inline confirmation (`Hapus` → `Yakin?`,
  auto-reset after 4 s) instead of `window.confirm()`.
- `applyStatus(orderId, status, control)` now resolves to `boolean`; the status
  `<select>` reverts when the database rejects the change, so the UI can never
  display a status the server refused.

### Fixed

- Empty numeric inputs no longer save as `0`. `Number('')` is `0`, so clearing
  the price, jastip fee, quota or DP field previously wrote a zero; the raw
  string is now checked for emptiness before the range check.
- `23503` foreign-key failures on product delete are translated into actionable
  copy ("set the quota to 0 instead of deleting") rather than a raw PostgREST
  message.

### Security

- Dashboard is gated on `supabase.auth.getSession()`: no query runs before a
  session exists, and the panel keeps `hidden` + `inert` while signed out.
- `clearSensitive()` empties product and order rows on sign-out, so an expired
  session cannot leave customer PII on screen or reachable by keyboard.
- Authorisation stays in Row Level Security. `admin.html` is public by design;
  without a session every write fails and no order data is returned. The anon
  key is the only key in the browser.
- Every database value is rendered with `textContent` or created nodes. A
  product named `<img src=x onerror=…>` and a customer named
  `<b>Aminah</b> <img …>` were confirmed to render as literal text.

## [0.3.0] — 2026-11-27

Phase 3: cart drawer, DP calculator and checkout handoff.
Commit [`fa9baba`](https://github.com/bukupedia/Jastip-Lokal/commit/fa9baba).

### Added

- Slide-over cart drawer with three steps in one element: `cart`, `checkout`,
  `success`. The active step is read back from the DOM, so there is no duplicate
  step state to drift.
- Persistent cart in `localStorage["jastip.cart.v1"]` as `{ id, qty, notes }`,
  re-joined with live product rows on every render.
- Per-line notes, capped at 200 characters.
- Transparent cost breakdown: product subtotal, jastip fees, grand total, DP
  and remaining balance — all integer Rupiah.
- Checkout form mirroring the RPC limits (name 3–100, WhatsApp, address 10–400,
  courier required) with inline field errors.
- Success screen with the order code and a `wa.me` deep link pre-filled with the
  itemised order, DP and remaining balance.

### Changed

- DP is now rounded **up** to the nearest Rp 100 and capped at the total, in
  both `js/config.js` `calcDp()` and `submit_jastip_order()` — the quoted DP
  always equals the stored DP.
- Quantities are clamped to `quota_available` on add, on change and after every
  product refresh (`Store.pruneCart` drops deleted products).
- Double submits are blocked by an `isSubmitting` flag plus a disabled button;
  `OUT_OF_STOCK`, `PRODUCT_NOT_FOUND` and `TRIP_CLOSED` trigger a product refresh
  so the cart re-clamps to the new quota.
- Postgres error hints are mapped to Indonesian messages before reaching the DOM.

### Fixed

- Temporal-dead-zone bug in the `Store` IIFE: `readCart()` ran in the `state`
  initialiser while `cleanNotes()` was declared below it, and the `try/catch`
  swallowed the `ReferenceError`, silently discarding the persisted cart.
  Helpers now sit above the state literal.

### Security

- Order creation goes exclusively through `submit_jastip_order()` with the anon
  key. The client posts `{ product_id, quantity, notes }` only; prices, quotas
  and `order_code` are resolved server-side.

## [0.2.0] — 2026-11-27

Phase 2: customer storefront.
Commit [`d91b486`](https://github.com/bukupedia/Jastip-Lokal/commit/d91b486) ·
`index.html` (374 lines), `js/app.js` (858 lines), `js/config.js` (201 lines).

### Added

- Semantic storefront: trip banner (city, PO close date with relative countdown,
  ETA, DP percentage), catalog grid, category chips, search, cart drawer shell.
- Skeleton loaders plus distinct empty, "no results" and load-error states with
  retry.
- `js/config.js`: configuration guard, `escapeHTML`, integer Rupiah and date
  formatters, `safeImageUrl`, `normalizePhoneId`, `debounce`.
- `js/app.js`: `ApiService`, `Store`, `UI`, `App` modules with pub/sub state and
  toast notifications.
- Content Security Policy in a `<meta>` tag, with each CDN listed in the
  directive it needs.

### Security

- Cards are cloned from `<template>` elements and filled with `textContent`;
  there is no string-built markup anywhere, so database values cannot become
  HTML.
- Only `SUPABASE_URL` and `SUPABASE_ANON_KEY` reach the browser.

## [0.1.0] — 2026-11-27

Phase 1: database schema, Row Level Security and the atomic order RPC.
Commit [`6b70b4b`](https://github.com/bukupedia/Jastip-Lokal/commit/6b70b4b) ·
`supabase/schema.sql` (510 lines), `supabase/seed.sql`.

### Added

- Tables `trip_settings` (id = 1 singleton), `products`, `orders`,
  `order_items`.
- Constraints: `products.category` limited to
  `Kuliner | Oleh-oleh | Fashion | Kerajinan`, `orders.status` limited to
  `PENDING_DP | DP_PAID | PURCHASED | SHIPPED | COMPLETED | CANCELLED`, and
  `dp_amount + remaining_amount = total_amount`.
- RPC `submit_jastip_order(payload jsonb)`: `SECURITY DEFINER` with a pinned
  `search_path`, server-side re-pricing, ordered `FOR UPDATE` row locks, atomic
  quota deduction and order-code generation. Returns the order code, totals, DP
  percentage and status.
- Error contract: `22023` validation, `P0002` product not found, `P0003` out of
  stock, `P0004` trip closed, `P0005` trip not configured, `23505` order-code
  collision, `P0001` internal error.
- `supabase/seed.sql` with demo trip settings and six products.

### Security

- RLS enabled on every table: public read on `trip_settings` and `products`,
  insert-only for `anon` on `orders` / `order_items`, select and update on
  `orders` for `authenticated` only, admin writes on the catalogue tables.
- `anon` has no `SELECT` on `orders` or `order_items`, so `insert(...).select()`
  fails by design — customer PII stays unreadable without a session.

### Verified

Against PostgreSQL 17 with `anon` and `authenticated` roles: RLS matrix, payload
validation, server-side re-pricing, out-of-stock rollback, and a three-way
concurrent race for the last unit (exactly one order wins, quota never goes
negative).

## [0.0.0] — 2026-11-27

Repository created. No application code.

---

### Version history at a glance

| Version | Phase | Scope | Commit |
| --- | --- | --- | --- |
| 0.1.0 | 1 | Schema, RLS, order RPC | `6b70b4b` |
| 0.2.0 | 2 | Storefront catalog | `d91b486` |
| 0.3.0 | 3 | Cart, DP, checkout | `fa9baba` |
| 0.4.0 | 4 | Admin panel, deployment docs | `e370e9b` |
