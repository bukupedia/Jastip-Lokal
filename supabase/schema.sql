-- ============================================================================
--  JASTIP LOKAL INDONESIA — PHASE 1: SCHEMA, RLS & RPC
--  Target : Supabase (PostgreSQL 15+)
--  Run in : Supabase Dashboard -> SQL Editor -> New query -> Run
--  Notes  : Idempotent — safe to run more than once.
--           Only the anon key is used by the frontend; all write protection
--           is enforced here by RLS + a SECURITY DEFINER function.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. trip_settings — singleton row (id is always 1) describing the active trip
-- ----------------------------------------------------------------------------
create table if not exists public.trip_settings (
  id                int         primary key default 1,
  destination_city  text,
  is_open           boolean     not null default true,
  close_date        timestamptz,
  arrival_estimate  text,
  dp_percentage     int         not null default 50,
  admin_whatsapp    text,
  constraint trip_settings_singleton_chk check (id = 1),
  constraint trip_settings_dp_pct_chk    check (dp_percentage between 0 and 100),
  constraint trip_settings_city_len_chk  check (destination_city is null or length(btrim(destination_city)) between 1 and 80)
);

insert into public.trip_settings (id) values (1) on conflict (id) do nothing;

comment on table public.trip_settings is
  'Single-row configuration of the currently active jastip trip.';

-- ----------------------------------------------------------------------------
-- 2. products — catalogue managed by the admin
-- ----------------------------------------------------------------------------
create table if not exists public.products (
  id               uuid        primary key default gen_random_uuid(),
  name             text        not null,
  category         text        not null,
  store_location   text,
  price            bigint      not null,
  jastip_fee       bigint      not null default 10000,
  quota_available  int         not null,
  image_url        text,
  created_at       timestamptz not null default now(),
  constraint products_name_len_chk check (length(btrim(name)) between 1 and 120),
  constraint products_category_chk check (category in ('Kuliner', 'Oleh-oleh', 'Fashion', 'Kerajinan')),
  constraint products_price_chk    check (price >= 0),
  constraint products_fee_chk      check (jastip_fee >= 0),
  constraint products_quota_chk    check (quota_available >= 0)
);

create index if not exists products_category_idx   on public.products (category);
create index if not exists products_created_at_idx on public.products (created_at desc);
create index if not exists products_name_idx       on public.products (lower(name));

-- ----------------------------------------------------------------------------
-- 3. orders / order_items
-- ----------------------------------------------------------------------------
create table if not exists public.orders (
  id                uuid        primary key default gen_random_uuid(),
  order_code        text        not null unique,
  customer_name     text        not null,
  customer_wa       text        not null,
  shipping_address  text        not null,
  courier           text        not null,
  total_amount      bigint      not null default 0,
  dp_amount         bigint      not null default 0,
  remaining_amount  bigint      not null default 0,
  status            text        not null default 'PENDING_DP',
  created_at        timestamptz not null default now(),
  constraint orders_code_len_chk  check (length(order_code) between 6 and 40),
  constraint orders_amounts_chk   check (total_amount >= 0 and dp_amount >= 0 and remaining_amount >= 0),
  constraint orders_amount_sum_chk check (dp_amount + remaining_amount = total_amount),
  constraint orders_status_chk    check (status in ('PENDING_DP', 'DP_PAID', 'PURCHASED', 'SHIPPED', 'COMPLETED', 'CANCELLED'))
);

create index if not exists orders_status_idx     on public.orders (status);
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_wa_idx         on public.orders (customer_wa);

create table if not exists public.order_items (
  id                 uuid   primary key default gen_random_uuid(),
  order_id           uuid   not null references public.orders (id)   on delete cascade,
  product_id         uuid   not null references public.products (id) on delete restrict,
  quantity           int    not null,
  notes              text,
  price_at_purchase  bigint not null,
  fee_at_purchase    bigint not null default 0,
  constraint order_items_qty_chk   check (quantity > 0),
  constraint order_items_price_chk check (price_at_purchase >= 0),
  constraint order_items_fee_chk   check (fee_at_purchase >= 0),
  constraint order_items_notes_chk check (notes is null or length(notes) <= 200)
);

create index if not exists order_items_order_idx   on public.order_items (order_id);
create index if not exists order_items_product_idx on public.order_items (product_id);

-- ----------------------------------------------------------------------------
-- 4. Row Level Security
--    RLS is enabled but NOT forced: the table owner (postgres) and
--    service_role keep full access, which is what the SECURITY DEFINER RPC
--    needs. Every client-facing path is still restricted by the policies below.
-- ----------------------------------------------------------------------------
alter table public.trip_settings enable row level security;
alter table public.products      enable row level security;
alter table public.orders        enable row level security;
alter table public.order_items   enable row level security;

-- trip_settings ---------------------------------------------------------------
drop policy if exists trip_settings_public_read on public.trip_settings;
create policy trip_settings_public_read
  on public.trip_settings for select
  to anon, authenticated
  using (true);

drop policy if exists trip_settings_admin_insert on public.trip_settings;
create policy trip_settings_admin_insert
  on public.trip_settings for insert
  to authenticated
  with check (true);

drop policy if exists trip_settings_admin_update on public.trip_settings;
create policy trip_settings_admin_update
  on public.trip_settings for update
  to authenticated
  using (true) with check (true);

drop policy if exists trip_settings_admin_delete on public.trip_settings;
create policy trip_settings_admin_delete
  on public.trip_settings for delete
  to authenticated
  using (true);

-- products --------------------------------------------------------------------
drop policy if exists products_public_read on public.products;
create policy products_public_read
  on public.products for select
  to anon, authenticated
  using (true);

drop policy if exists products_admin_insert on public.products;
create policy products_admin_insert
  on public.products for insert
  to authenticated
  with check (true);

drop policy if exists products_admin_update on public.products;
create policy products_admin_update
  on public.products for update
  to authenticated
  using (true) with check (true);

drop policy if exists products_admin_delete on public.products;
create policy products_admin_delete
  on public.products for delete
  to authenticated
  using (true);

-- orders ----------------------------------------------------------------------
-- Customers may create an order but can never read it back (no PII leakage).
-- The supported path is submit_jastip_order(); this INSERT policy exists for
-- completeness and is locked down by a strict WITH CHECK.
drop policy if exists orders_public_insert on public.orders;
create policy orders_public_insert
  on public.orders for insert
  to anon, authenticated
  with check (
    status = 'PENDING_DP'
    and total_amount > 0
    and dp_amount >= 0
    and remaining_amount >= 0
    and dp_amount + remaining_amount = total_amount
    and length(btrim(customer_name)) between 3 and 100
    and length(btrim(shipping_address)) between 10 and 400
    and length(btrim(courier)) between 2 and 60
  );

drop policy if exists orders_admin_read on public.orders;
create policy orders_admin_read
  on public.orders for select
  to authenticated
  using (true);

drop policy if exists orders_admin_update on public.orders;
create policy orders_admin_update
  on public.orders for update
  to authenticated
  using (true) with check (true);

-- order_items -----------------------------------------------------------------
drop policy if exists order_items_public_insert on public.order_items;
create policy order_items_public_insert
  on public.order_items for insert
  to anon, authenticated
  with check (
    quantity > 0
    and price_at_purchase >= 0
    and fee_at_purchase >= 0
    and (notes is null or length(notes) <= 200)
  );

drop policy if exists order_items_admin_read on public.order_items;
create policy order_items_admin_read
  on public.order_items for select
  to authenticated
  using (true);

-- ----------------------------------------------------------------------------
-- 5. Explicit table privileges. Supabase grants broad access by default, so
--    we narrow it down and let the policies above be the only gate.
-- ----------------------------------------------------------------------------
revoke all on table public.trip_settings, public.products, public.orders, public.order_items
  from anon, authenticated;

grant select on table public.trip_settings, public.products to anon, authenticated;
grant insert, update, delete on table public.trip_settings, public.products to authenticated;

grant insert on table public.orders, public.order_items to anon, authenticated;
grant select, update on table public.orders to authenticated;
grant select on table public.order_items to authenticated;

-- ----------------------------------------------------------------------------
-- 6. RPC: submit_jastip_order(payload jsonb)
--
--    Atomic order creation: validates the payload, locks the product rows,
--    re-prices everything server-side (client prices are ignored), deducts
--    quota, and writes orders + order_items in a single transaction.
--
--    Payload shape:
--      {
--        "customer_name":    "Budi Santoso",
--        "customer_wa":      "08123456789",
--        "shipping_address": "Jl. Merdeka No. 1, Jakarta Pusat",
--        "courier":          "JNE REG",
--        "items": [
--          { "product_id": "<uuid>", "quantity": 2, "notes": "yang pedas" }
--        ]
--      }
--
--    Returns: { order_id, order_code, customer_name, total_amount, dp_amount,
--               dp_percentage, remaining_amount, status }
--
--    Error codes (supabase-js exposes error.code / error.hint):
--      22023  VALIDATION_ERROR     invalid payload
--      P0002  PRODUCT_NOT_FOUND    product id does not exist
--      P0003  OUT_OF_STOCK         quota_available < quantity
--      P0004  TRIP_CLOSED          trip closed or close_date passed
--      P0005  TRIP_NOT_CONFIGURED  no trip_settings row
--      23505  ORDER_CODE_FAILED    could not generate a unique order_code
--      P0001  INTERNAL_ERROR       unexpected failure (details only in logs)
-- ----------------------------------------------------------------------------
create or replace function public.submit_jastip_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c_max_items constant int := 50;
  c_max_qty   constant int := 999;

  v_settings   public.trip_settings;
  v_name       text;
  v_wa         text;
  v_address    text;
  v_courier    text;
  v_items      jsonb;
  v_elem       jsonb;
  v_pid        uuid;
  v_qty        int;
  v_seen       uuid[] := '{}';
  v_found      int;
  v_row        record;
  v_subtotal   bigint := 0;
  v_total_fee  bigint := 0;
  v_total      bigint := 0;
  v_dp         bigint := 0;
  v_remaining  bigint := 0;
  v_order_id   uuid   := gen_random_uuid();
  v_order_code text;
  v_attempt    int    := 0;
begin
  -- ---- payload validation --------------------------------------------------
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'Data pesanan tidak valid.'
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  v_name := btrim(coalesce(payload ->> 'customer_name', ''));
  if length(v_name) < 3 or length(v_name) > 100 then
    raise exception 'Nama pemesan harus 3-100 karakter.'
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  v_wa := regexp_replace(coalesce(payload ->> 'customer_wa', ''), '\D', '', 'g');
  if v_wa like '0%' then
    v_wa := '62' || substr(v_wa, 2);
  elsif v_wa not like '62%' then
    v_wa := '62' || v_wa;
  end if;
  if length(v_wa) < 10 or length(v_wa) > 15 then
    raise exception 'Nomor WhatsApp tidak valid.'
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  v_address := btrim(coalesce(payload ->> 'shipping_address', ''));
  if length(v_address) < 10 or length(v_address) > 400 then
    raise exception 'Alamat pengiriman harus 10-400 karakter.'
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  v_courier := btrim(coalesce(payload ->> 'courier', ''));
  if length(v_courier) < 2 or length(v_courier) > 60 then
    raise exception 'Kurir wajib dipilih.'
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  v_items := payload -> 'items';
  if v_items is null or jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then
    raise exception 'Pesanan harus berisi minimal 1 produk.'
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;
  if jsonb_array_length(v_items) > c_max_items then
    raise exception 'Maksimal % produk per pesanan.', c_max_items
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  -- validate every element before casting so we never surface a raw 22P02
  for v_elem in select value from jsonb_array_elements(v_items) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'Format item pesanan tidak valid.'
        using errcode = '22023', hint = 'VALIDATION_ERROR';
    end if;

    if coalesce(v_elem ->> 'product_id', '')
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'ID produk tidak valid.'
        using errcode = '22023', hint = 'VALIDATION_ERROR';
    end if;

    v_pid := (v_elem ->> 'product_id')::uuid;
    if v_pid = any (v_seen) then
      raise exception 'Produk yang sama tidak boleh dikirim dua kali dalam satu pesanan.'
        using errcode = '22023', hint = 'VALIDATION_ERROR';
    end if;
    v_seen := v_seen || v_pid;

    if coalesce(v_elem ->> 'quantity', '') !~ '^[0-9]{1,3}$' then
      raise exception 'Jumlah produk harus bilangan bulat 1-999.'
        using errcode = '22023', hint = 'VALIDATION_ERROR';
    end if;
    v_qty := (v_elem ->> 'quantity')::int;
    if v_qty < 1 or v_qty > c_max_qty then
      raise exception 'Jumlah produk harus antara 1 dan %.', c_max_qty
        using errcode = '22023', hint = 'VALIDATION_ERROR';
    end if;

    if length(coalesce(v_elem ->> 'notes', '')) > 200 then
      raise exception 'Catatan per item maksimal 200 karakter.'
        using errcode = '22023', hint = 'VALIDATION_ERROR';
    end if;
  end loop;

  -- ---- trip availability ---------------------------------------------------
  select * into v_settings from public.trip_settings where id = 1;
  if not found then
    raise exception 'Pengaturan trip belum dikonfigurasi oleh admin.'
      using errcode = 'P0005', hint = 'TRIP_NOT_CONFIGURED';
  end if;
  if not coalesce(v_settings.is_open, false) then
    raise exception 'Trip sedang ditutup. Silakan cek kembali nanti.'
      using errcode = 'P0004', hint = 'TRIP_CLOSED';
  end if;
  if v_settings.close_date is not null and v_settings.close_date <= now() then
    raise exception 'Batas waktu pemesanan sudah berakhir.'
      using errcode = 'P0004', hint = 'TRIP_CLOSED';
  end if;

  -- ---- products must exist -------------------------------------------------
  select count(*) into v_found from public.products p where p.id = any (v_seen);
  if v_found <> array_length(v_seen, 1) then
    raise exception 'Salah satu produk tidak ditemukan atau sudah dihapus.'
      using errcode = 'P0002', hint = 'PRODUCT_NOT_FOUND';
  end if;

  -- ---- lock rows (ordered by id -> no deadlocks), price server-side -------
  for v_row in
    select p.id, p.name, p.price, p.jastip_fee, p.quota_available,
           (e.value ->> 'quantity')::int as quantity
      from jsonb_array_elements(v_items) as e (value)
      join public.products p on p.id = (e.value ->> 'product_id')::uuid
     order by p.id
       for update of p
  loop
    if v_row.quota_available < v_row.quantity then
      raise exception 'Stok "%" tidak mencukupi (tersisa %).',
                      v_row.name, v_row.quota_available
        using errcode = 'P0003', hint = 'OUT_OF_STOCK';
    end if;

    v_subtotal  := v_subtotal  + (v_row.price * v_row.quantity);
    v_total_fee := v_total_fee + (v_row.jastip_fee * v_row.quantity);
  end loop;

  v_total := v_subtotal + v_total_fee;
  if v_total <= 0 then
    raise exception 'Total pesanan tidak valid.'
      using errcode = '22023', hint = 'VALIDATION_ERROR';
  end if;

  -- Whole-rupiah arithmetic only. The DP is rounded UP to the nearest Rp 100
  -- (never under-pay) and capped at the total; js/config.js calcDp() mirrors
  -- this exactly so the quoted DP equals the stored DP.
  v_dp := least(
            (ceil((v_total * v_settings.dp_percentage)::numeric / 10000) * 100)::bigint,
            v_total
          );
  v_remaining := v_total - v_dp;

  -- ---- create the order (retry on the unlikely order_code collision) ------
  loop
    v_attempt := v_attempt + 1;
    v_order_code := 'JL'
      || to_char((now() at time zone 'Asia/Jakarta'), 'YYMMDD')
      || '-'
      || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

    begin
      insert into public.orders (
        id, order_code, customer_name, customer_wa, shipping_address, courier,
        total_amount, dp_amount, remaining_amount, status
      ) values (
        v_order_id, v_order_code, v_name, v_wa, v_address, v_courier,
        v_total, v_dp, v_remaining, 'PENDING_DP'
      );
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise exception 'Gagal membuat kode pesanan. Silakan coba lagi.'
          using errcode = '23505', hint = 'ORDER_CODE_FAILED';
      end if;
    end;
  end loop;

  -- ---- persist items and deduct quota -------------------------------------
  for v_row in
    select p.id, p.name, p.price, p.jastip_fee,
           (e.value ->> 'quantity')::int as quantity,
           nullif(btrim(coalesce(e.value ->> 'notes', '')), '') as notes
      from jsonb_array_elements(v_items) as e (value)
      join public.products p on p.id = (e.value ->> 'product_id')::uuid
     order by p.id
  loop
    insert into public.order_items (
      order_id, product_id, quantity, notes, price_at_purchase, fee_at_purchase
    ) values (
      v_order_id, v_row.id, v_row.quantity, v_row.notes, v_row.price, v_row.jastip_fee
    );

    update public.products
       set quota_available = quota_available - v_row.quantity
     where id = v_row.id
       and quota_available >= v_row.quantity;

    if not found then
      raise exception 'Stok "%" tidak mencukupi.', v_row.name
        using errcode = 'P0003', hint = 'OUT_OF_STOCK';
    end if;
  end loop;

  return jsonb_build_object(
    'order_id',         v_order_id,
    'order_code',       v_order_code,
    'customer_name',    v_name,
    'total_amount',     v_total,
    'dp_amount',        v_dp,
    'dp_percentage',    v_settings.dp_percentage,
    'remaining_amount', v_remaining,
    'status',           'PENDING_DP'
  );

exception
  when others then
    -- Never leak schema/constraint internals to the browser.
    if sqlstate in ('22023', 'P0002', 'P0003', 'P0004', 'P0005', '23505') then
      raise;
    end if;
    raise warning 'submit_jastip_order failed [%]: %', sqlstate, sqlerrm;
    raise exception 'Terjadi kesalahan saat memproses pesanan. Silakan coba lagi.'
      using errcode = 'P0001', hint = 'INTERNAL_ERROR';
end;
$fn$;

comment on function public.submit_jastip_order(jsonb) is
  'Atomically creates an order (server-side pricing + quota deduction). Callable by anon.';

revoke all on function public.submit_jastip_order(jsonb) from public;
grant execute on function public.submit_jastip_order(jsonb) to anon, authenticated;

commit;

-- ============================================================================
--  Optional post-run checks (run manually):
--
--    select * from public.trip_settings;
--    select id, name, category, price, quota_available from public.products;
--    select tablename, rowsecurity from pg_tables where schemaname = 'public';
--
--    -- as anon this must fail with "permission denied for table orders":
--    begin;
--    set local role anon;
--    select count(*) from public.orders;
--    rollback;
-- ============================================================================
