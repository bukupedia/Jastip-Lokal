# Jastip Lokal Indonesia — Project Memory

Static site on GitHub Pages + Supabase. No build step: plain HTML/CSS/JS with
Tailwind and Font Awesome via CDN.

## Layout

```
supabase/schema.sql   # Phase 1: tables, RLS policies, grants, submit_jastip_order()
supabase/seed.sql     # dev-only demo data (trip settings + 6 products)
index.html            # Phase 2: customer storefront (markup + <template>s)
js/config.js          # CONFIG, CATEGORIES, escapeHTML, formatRupiah, …
js/app.js             # Phase 2-3: ApiService / Store / UI / App modules
admin.html            # Phase 4: admin panel shell (login + dashboard markup)
js/admin.js           # Phase 4: AdminApi / AdminStore / AdminUI / AdminApp
```

## Hard rules

- Frontend only ever gets `SUPABASE_URL` + `SUPABASE_ANON_KEY`. Never the
  service role key.
- Never `innerHTML` with data. Use `textContent` or `escapeHTML()`.
- All money is `bigint`/integer Rupiah. No `parseFloat` on prices.
- Order creation goes through the RPC `submit_jastip_order(payload jsonb)`,
  never through direct table inserts. Prices and quotas are resolved server-side.

## Frontend notes (Phase 2)

- `js/app.js` is four IIFEs: `ApiService` (only Supabase caller), `Store`
  (state + pub/sub + localStorage cart), `UI` (renders, never mutates state),
  `App` (event wiring). `UI` receives `tripOpen` as an argument instead of
  reading `Store`, so rendering stays a pure function of its inputs.
- Product/cart cards are cloned from `<template>` elements and filled with
  `textContent`. There is no string-built markup anywhere, so DB values cannot
  become HTML.
- Category chips are styled from `aria-pressed` (CSS in the
  `<style type="text/tailwindcss">` block), so the accessible state and the
  visual state cannot drift apart.
- The cart lives in `localStorage` under `jastip.cart.v1` as `[{id, qty}]` and
  is re-joined with live product rows on every render (`Store.pruneCart` drops
  deleted products and clamps quantities to the current quota).
- The cart CTA opens `wa.me` with a pre-filled summary; `normalizePhoneId()`
  converts `0812…` to `62812…` because wa.me rejects the leading zero.
- CSP lives in a `<meta>` tag. If you add a CDN, add it to the right directive —
  Font Awesome needs `style-src` **and** `font-src` for cdnjs, Tailwind needs
  `script-src` for cdn.tailwindcss.com plus `'unsafe-inline'` for its config
  and `<style type="text/tailwindcss">` block.
- Supabase error text is logged to the console and replaced with a generic
  Indonesian message before it reaches the DOM (PostgREST messages leak schema
  details).

## Database contract (Phase 1, verified against PostgreSQL 17)

`products.category` is one of `Kuliner | Oleh-oleh | Fashion | Kerajinan`.

`orders.status` is one of `PENDING_DP | DP_PAID | PURCHASED | SHIPPED | COMPLETED | CANCELLED`
(enforced by `orders_status_chk` — add a migration before using new values).

`orders` keeps the invariant `dp_amount + remaining_amount = total_amount`
(`orders_amount_sum_chk`).

### RPC

```js
const { data, error } = await supabase.rpc('submit_jastip_order', {
  payload: {
    customer_name: 'Budi Santoso',
    customer_wa: '08123456789',        // normalised to 62… server-side
    shipping_address: 'Jl. Merdeka No. 1, Jakarta Pusat',
    courier: 'JNE REG',
    items: [{ product_id: '<uuid>', quantity: 2, notes: 'yang pedas' }]
  }
});
```

Returns `{ order_id, order_code, customer_name, total_amount, dp_amount,
dp_percentage, remaining_amount, status }`.

Client-supplied prices are ignored. Duplicate `product_id` in one payload is
rejected — merge quantities in the cart before submitting.

Error mapping (`error.code` / `error.hint`):

| code  | hint                 | meaning                          |
|-------|----------------------|----------------------------------|
| 22023 | VALIDATION_ERROR     | payload invalid                  |
| P0002 | PRODUCT_NOT_FOUND    | product deleted/unknown          |
| P0003 | OUT_OF_STOCK         | quota < requested qty            |
| P0004 | TRIP_CLOSED          | `is_open = false` or past close  |
| P0005 | TRIP_NOT_CONFIGURED  | no `trip_settings` row           |
| 23505 | ORDER_CODE_FAILED    | order_code collision             |
| P0001 | INTERNAL_ERROR       | unexpected (details in PG logs)  |

### RLS summary

| table          | anon                     | authenticated |
|----------------|--------------------------|---------------|
| trip_settings  | SELECT                   | all           |
| products       | SELECT                   | all           |
| orders         | INSERT (no RETURNING)    | SELECT, UPDATE|
| order_items    | INSERT                   | SELECT        |

`anon` has no SELECT on `orders`/`order_items`, so `insert(...).select()` fails
with *permission denied* — that is intentional PII protection.

## Verification

`schema.sql` was tested on PostgreSQL 17 with `anon`/`authenticated` roles:
RLS matrix, payload validation, server-side re-pricing, out-of-stock rollback,
and a 3-way concurrent race on the last unit (exactly one order wins, quota
never negative).

## Phase 3 — cart, DP calculator, Supabase + WhatsApp checkout

Flow inside the single cart drawer (`#cart-drawer`), three stacked sections:

| step       | element                | notes                                   |
|------------|------------------------|-----------------------------------------|
| `cart`     | `#cart-step-cart`      | lines, notes, cost breakdown, CTA       |
| `checkout` | `#cart-step-checkout`  | `<form novalidate>`, mirrors RPC limits |
| `success`  | `#cart-step-success`   | order code + wa.me confirmation link    |

`UI.setCartStep(step)` only toggles `hidden`; the step is read back from the DOM
(`App.currentStep()`), so no duplicate state exists.

Cart lines are `{ id, qty, notes }` in `localStorage["jastip.cart.v1"]`. Notes are
capped at 200 chars and rendered with `textContent`. `Store.setNote()` is
intentionally silent (no `notify()`), otherwise re-rendering the list would steal
focus from the field being typed into.

Money: `getCartSummary()` returns `productSubtotal`, `totalFees`, `grandTotal`,
`dp`, `remaining` — all integers. DP uses `calcDp()` (round up to Rp 100, cap at
total) which mirrors `submit_jastip_order()` in `supabase/schema.sql`. Keep both
in sync if either changes.

Checkout posts only `{ product_id, quantity, notes }` — the RPC re-prices, checks
quota and generates `order_code`. Double submits are blocked by an `isSubmitting`
flag plus a disabled button, and `OUT_OF_STOCK` / `PRODUCT_NOT_FOUND` / `TRIP_CLOSED`
trigger a product refresh so the cart re-clamps to the new quota.

After success the cart is cleared and the customer gets a `wa.me` deep link with
the order code, itemised lines, DP and remaining balance pre-filled.

### Gotcha: TDZ in the module IIFEs

`Store` builds its initial `state` object (which calls `readCart()`) at the top of
the IIFE. Any helper it uses must be declared **above** that object literal —
`const` helpers declared below are in the temporal dead zone and the `try/catch`
in `readCart` swallows the `ReferenceError`, silently losing the persisted cart.
This exact bug shipped once; keep `cleanNotes()` above `state`.

## Phase 4 — admin panel (`admin.html` + `js/admin.js`)

Four IIFEs, same shape as the storefront: `AdminApi` (only Supabase caller),
`AdminStore` (session + data snapshot + pub/sub), `AdminUI` (renders, never
mutates), `AdminApp` (auth flow, validation, event wiring).

### Auth gate

`boot()` calls `supabase.auth.getSession()`. Only a non-null session reaches
`enterDashboard()` — no data is fetched before that, so a logged-out visitor
never triggers a single query. While signed out the dashboard element keeps
`hidden` + `inert` and `AdminUI.clearSensitive()` wipes previously rendered
rows, so an expired session cannot leave customer PII on screen or in the tab
order. `onAuthStateChange` is wrapped in `setTimeout(0)` because Supabase warns
against awaiting its own calls inside that callback; it only reacts to
`SIGNED_OUT`/`session === null`.

Security is enforced by RLS, not by this page: `anon` can read `trip_settings`
and `products` but cannot write anything or read `orders`. Anyone can open
`admin.html`; without a valid session every write fails and no order data is
returned. Do not "fix" that by adding client-side role checks and calling it
security.

### Tabs

`#panel-trip`, `#panel-products`, `#panel-orders` toggled by `AdminUI.selectTab`
via `aria-selected` on the `[role="tab"]` buttons. The orders tab shows a badge
with the count of `PENDING_DP` orders.

### Validation quirks worth keeping

- Numeric inputs are read as trimmed strings first. `Number('')` is `0`, so an
  empty price/quota field would otherwise save as a zero — the raw string is
  checked for emptiness before the numeric range check.
- `dp_percentage` is `Math.trunc()`ed and clamped to 0–100; `close_date` is
  converted with `new Date(value).toISOString()` and rejected when `NaN`.
- Product delete uses a two-step inline confirm (`Hapus` → `Yakin?`, auto-reset
  after 4 s) instead of `window.confirm()`: a blocking native dialog cannot be
  styled, freezes mobile Safari, and silently no-ops in automated tests.
- `DELETE /products` on a product referenced by `order_items` returns `23503`.
  `mapDbError()` turns that into "set the quota to 0 instead", which is the
  supported way to retire a product without breaking order history.

### Order status updates

`applyStatus(orderId, status, control)` returns a `Promise<boolean>` — `true`
only when the database accepted the change. The `<select>` reverts on `false`
and the "next step" button re-renders, so the UI can never show a status the
server rejected. Valid values must mirror `ORDER_STATUS_ORDER`, which mirrors
the `orders_status_chk` constraint.

## Deployment (GitHub Pages)

1. Repository → Settings → Pages → Source: *Deploy from a branch*, branch
   `main`, folder `/ (root)`. Everything is static; there is no build step.
2. Fill `js/config.js` with the project URL and the **anon** key before pushing.
   The anon key is public by design — RLS is what protects the data.
3. Supabase → Authentication → URL Configuration: add the Pages origin
   (`https://<user>.github.io`) to *Site URL* / *Redirect URLs*, otherwise the
   session cookie flow breaks on the custom domain.
4. Supabase → Authentication → Users: create the admin account manually. There
   is no public sign-up form, and none should be added.
5. `https://<user>.github.io/<repo>/` serves the storefront, `/admin.html` the
   panel. Both share `js/config.js`, so keep the paths relative (they already
   are) — a leading `/` would break project pages.
