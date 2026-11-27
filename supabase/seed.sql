-- ============================================================================
--  JASTIP LOKAL INDONESIA — DEV SEED DATA
--  Run AFTER supabase/schema.sql. Safe to re-run (idempotent upserts).
--  Do NOT run on production unless you really want these demo rows.
-- ============================================================================

insert into public.trip_settings (
  id, destination_city, is_open, close_date, arrival_estimate, dp_percentage, admin_whatsapp
) values (
  1, 'Bandung', true, now() + interval '10 days',
  'Estimasi tiba di Jakarta: 3 hari setelah order ditutup', 50, '6281234567890'
)
on conflict (id) do update set
  destination_city = excluded.destination_city,
  is_open          = excluded.is_open,
  close_date       = excluded.close_date,
  arrival_estimate = excluded.arrival_estimate,
  dp_percentage    = excluded.dp_percentage,
  admin_whatsapp   = excluded.admin_whatsapp;

insert into public.products (id, name, category, store_location, price, jastip_fee, quota_available, image_url)
values
  ('11111111-1111-4111-8111-111111111111', 'Brownies Kukus Amanda',      'Kuliner',    'Kartika Sari Dago',      65000, 10000, 20, null),
  ('22222222-2222-4222-8222-222222222222', 'Bakpia Pathok 25 Isi 10',    'Oleh-oleh',  'Bakpia Pathok 25',       45000, 10000, 15, null),
  ('33333333-3333-4333-8333-333333333333', 'Kaos Oblong Distro Cihampelas', 'Fashion', 'Jl. Cihampelas No. 12', 85000, 15000,  5, null),
  ('44444444-4444-4444-8444-444444444444', 'Keripik Ma Icih Pedas',      'Kuliner',    'Toko Ma Icih Cihampelas', 32000, 10000, 30, null),
  ('55555555-5555-4555-8555-555555555555', 'Wayang Golek Miniatur',      'Kerajinan',  'Sentra Kerajinan Cibiru', 175000, 20000,  3, null),
  ('66666666-6666-4666-8666-666666666666', 'Peuyeum Bandung Premium',    'Oleh-oleh',  'Pasar Baru Bandung',      28000, 10000, 25, null)
on conflict (id) do nothing;
