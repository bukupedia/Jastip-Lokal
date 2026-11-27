# Jastip Lokal Indonesia

Titip-beli (jastip) storefront for local products, built as a static site for
GitHub Pages with Supabase as the backend. No build step — plain HTML, Tailwind
and Font Awesome from CDN, Supabase JS v2 from CDN.

- `index.html` — customer storefront: trip banner, catalog, cart, DP checkout
- `admin.html` — admin panel: trip settings, product CRUD, incoming orders

## 1. Supabase setup

1. Create a project, then run `supabase/schema.sql` in the SQL editor. It
   creates the tables, RLS policies, grants and the `submit_jastip_order()` RPC.
2. Optional demo data: `supabase/seed.sql`.
3. Authentication → Users → *Add user*: create the admin account with
   email + password. There is no public sign-up form, and none should be added.
4. Authentication → URL Configuration: add your site origin
   (`http://localhost:PORT` for local work, `https://<user>.github.io` in
   production) to *Site URL* and *Redirect URLs*.

## 2. Configure the frontend

Edit `js/config.js`:

```js
SUPABASE_URL: 'https://<project-ref>.supabase.co',
SUPABASE_ANON_KEY: '<anon public key>',
```

Use the **anon** key only. The service role key must never reach the browser —
row level security is what stops an anonymous visitor from writing data or
reading orders. RLS grants:

| table | anon | authenticated |
| --- | --- | --- |
| `trip_settings` | select | all |
| `products` | select | all |
| `orders` | insert via RPC only | select, update |
| `order_items` | insert via RPC only | select |

## 3. Run locally

Any static server works, for example:

```bash
python3 -m http.server 8000
# storefront: http://localhost:8000/
# admin:      http://localhost:8000/admin.html
```

## 4. Deploy to GitHub Pages

1. Settings → Pages → *Deploy from a branch* → branch `main`, folder `/ (root)`.
2. Push. The site appears at `https://<user>.github.io/<repo>/`.
3. Open `https://<user>.github.io/<repo>/admin.html`, sign in with the account
   created in step 1.3.
4. All asset paths are relative (`./js/…`) so project pages work under a
   subdirectory. Do not switch them to absolute `/…` paths.

## How ordering works

The storefront posts `{ product_id, quantity, notes }` to the
`submit_jastip_order()` RPC. Prices, jastip fees, quotas and the DP are resolved
server-side inside one transaction, so a tampered client cannot change what it
pays or oversell a product. The customer then gets a `wa.me` link with the order
code, DP and remaining balance pre-filled.

## Admin workflow

1. **Trip** — destination city, DP percentage, PO close date, ETA, admin
   WhatsApp, open/closed switch. Closing PO disables ordering in the storefront.
2. **Produk** — add or edit products; set quota to `0` to hide a product from the
   store while keeping past orders intact. Products already referenced by an
   order cannot be deleted (foreign key) — retire them via quota instead.
3. **Pesanan** — advance an order through
   `Menunggu DP → DP Dikonfirmasi → Barang Dibeli → Dikirim → Selesai`
   (or cancel it), then message the customer with one click.
