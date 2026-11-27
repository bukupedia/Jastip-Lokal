# Jastip Lokal Indonesia — Project Memory

Static site on GitHub Pages + Supabase. No build step: plain HTML/CSS/JS with
Tailwind and Font Awesome via CDN.

## Layout

```
supabase/schema.sql   # Phase 1: tables, RLS policies, grants, submit_jastip_order()
supabase/seed.sql     # dev-only demo data (trip settings + 6 products)
index.html            # Phase 2: customer storefront
admin.html            # Phase 3: admin dashboard (Supabase Auth)
assets/js/            # config / supabase service / state / ui modules
```

## Hard rules

- Frontend only ever gets `SUPABASE_URL` + `SUPABASE_ANON_KEY`. Never the
  service role key.
- Never `innerHTML` with data. Use `textContent` or `escapeHTML()`.
- All money is `bigint`/integer Rupiah. No `parseFloat` on prices.
- Order creation goes through the RPC `submit_jastip_order(payload jsonb)`,
  never through direct table inserts. Prices and quotas are resolved server-side.

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
