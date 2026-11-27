# Jastip Lokal Indonesia — Project Memory

Static site on GitHub Pages + Supabase. No build step: plain HTML/CSS/JS with
Tailwind and Font Awesome via CDN.

## Layout

```
supabase/schema.sql   # Phase 1: tables, RLS policies, grants, submit_jastip_order()
supabase/seed.sql     # dev-only demo data (trip settings + 6 products)
index.html            # Phase 2: customer storefront (markup + <template>s)
js/config.js          # CONFIG, CATEGORIES, escapeHTML, formatRupiah, …
js/app.js             # ApiService / Store / UI / App modules, in that order
admin.html            # Phase 3: admin dashboard (Supabase Auth)
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
