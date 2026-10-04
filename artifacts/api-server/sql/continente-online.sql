-- REQUIRED SETUP, NOT RUN AUTOMATICALLY.
-- Review/apply to the existing Supabase project before enabling commit.
-- Existing duplicate source identities make this transaction fail, not delete data.
-- Unknown package formats must remain NULL instead of the default "unidade".
begin;

alter table public.products alter column unit drop not null;

create unique index if not exists products_continente_identity_key
  on public.products (source_type, external_id)
  where source_type = 'continente' and external_id is not null;
create unique index if not exists stores_continente_identity_key
  on public.stores (source_type, external_id)
  where source_type = 'continente' and external_id is not null;
create unique index if not exists prices_continente_identity_key
  on public.prices (source_type, external_id)
  where source_type = 'continente' and external_id is not null;

create table if not exists public.external_product_mappings (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type = btrim(source_type) and source_type <> ''),
  external_product_id text not null check (external_product_id = btrim(external_product_id) and external_product_id <> ''),
  product_id uuid not null references public.products(id) on delete restrict,
  match_method text not null check (
    match_method in ('source_native', 'barcode_exact', 'name_brand_exact_unique', 'manual_verified')
  ),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, external_product_id)
);
create index if not exists external_product_mappings_product_idx
  on public.external_product_mappings(product_id);
alter table public.external_product_mappings enable row level security;
revoke all on public.external_product_mappings from anon, authenticated;
grant select, insert, update on public.external_product_mappings to service_role;

create or replace function public.touch_external_product_mapping()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at = pg_catalog.now(); return new; end; $$;
drop trigger if exists touch_external_product_mapping on public.external_product_mappings;
create trigger touch_external_product_mapping
  before update on public.external_product_mappings
  for each row execute function public.touch_external_product_mapping();

-- The exact contract consumed by the server. Only the Continente online channel
-- is authorized here. Price + first/changed history are one database transaction.
create or replace function public.upsert_verified_price_with_history(
  p_product_id uuid,
  p_store_id uuid,
  p_price numeric,
  p_currency text,
  p_captured_at timestamptz,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_source_type text,
  p_external_id text,
  p_source_reference text,
  p_promotion boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  existing public.prices%rowtype;
  existing_count integer;
  saved_id uuid;
  sku text;
  created boolean := false;
  changed boolean := false;
begin
  if p_source_type is distinct from 'continente'
     or p_currency is distinct from 'EUR'
     or p_external_id is null or p_external_id !~ '^online:[1-9][0-9]*$'
     or p_price is null or p_price <= 0 or p_price <> round(p_price, 2)
     or p_captured_at is null or not isfinite(p_captured_at)
     or p_captured_at > now() or p_captured_at + interval '36 hours' <= now()
     or p_valid_from is distinct from p_captured_at
     or p_valid_until is distinct from (p_captured_at + interval '36 hours')
     or p_promotion is null
  then raise exception 'Invalid Continente online price/freshness'; end if;
  sku := substring(p_external_id from 8);
  if p_source_reference is null or
     p_source_reference !~ ('^https://www\.continente\.pt/produto/[^?#]+-' || sku || '\.html$')
  then raise exception 'Invalid public product reference'; end if;
  if not exists (
    select 1 from public.stores where id = p_store_id and active
      and source_type = 'continente' and external_id = 'online'
      and name = 'Continente Online' and store_type = 'online'
      and district is null and municipality is null and parish is null
      and latitude is null and longitude is null
  ) then raise exception 'Price target is not Continente Online'; end if;
  if not exists (
    select 1 from public.external_product_mappings m
    join public.products p on p.id = m.product_id and p.active
    where m.source_type = 'continente' and m.external_product_id = sku
      and m.product_id = p_product_id and m.verified
  ) then raise exception 'Missing verified product mapping'; end if;

  -- Serialize all writers of this external online price. Unique index also
  -- prevents accidental duplicates from clients outside this RPC.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('continente:' || p_external_id, 0)
  );
  select count(*) into existing_count from public.prices
    where source_type = 'continente' and external_id = p_external_id;
  if existing_count > 1 then raise exception 'Duplicate current price identity'; end if;
  select * into existing from public.prices
    where source_type = 'continente' and external_id = p_external_id for update;
  if found then
    if existing.product_id <> p_product_id or existing.store_id <> p_store_id
    then raise exception 'Existing price points to a different product/store'; end if;
    saved_id := existing.id;
    if p_captured_at < existing.captured_at or
       (p_captured_at = existing.captured_at and p_price <> existing.price) then
      return jsonb_build_object(
        'price_id', saved_id, 'price_created', false, 'price_changed', false,
        'history_created', false, 'stale_observation', true
      );
    end if;
    changed := existing.price is distinct from p_price;
    update public.prices set
      price = p_price, currency = 'EUR', promotion = p_promotion,
      captured_at = p_captured_at, valid_from = p_valid_from,
      valid_until = p_valid_until, source_reference = p_source_reference,
      verification_status = 'verified'
    where id = saved_id;
  else
    insert into public.prices (
      product_id, store_id, price, currency, promotion, captured_at,
      valid_from, valid_until, source_type, external_id, source_reference, verification_status
    ) values (
      p_product_id, p_store_id, p_price, 'EUR', p_promotion, p_captured_at,
      p_valid_from, p_valid_until, 'continente', p_external_id, p_source_reference, 'verified'
    ) returning id into saved_id;
    created := true;
  end if;
  if created or changed then
    insert into public.price_history(product_id, store_id, price, captured_at)
      values(p_product_id, p_store_id, p_price, p_captured_at);
  end if;
  return jsonb_build_object(
    'price_id', saved_id, 'price_created', created, 'price_changed', changed,
    'history_created', (created or changed), 'stale_observation', false
  );
end;
$$;
revoke all on function public.upsert_verified_price_with_history(
  uuid,uuid,numeric,text,timestamptz,timestamptz,timestamptz,text,text,text,boolean
) from public, anon, authenticated;
grant execute on function public.upsert_verified_price_with_history(
  uuid,uuid,numeric,text,timestamptz,timestamptz,timestamptz,text,text,text,boolean
) to service_role;

-- GET-only preflight, so missing uniqueness protections block commit before
-- any store/product/mapping insert. No writes and no credential exposure.
create or replace function public.continente_sync_capabilities()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'product_identity_unique', exists (
      select 1 from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'products_continente_identity_key' and i.indisunique and i.indisvalid
    ),
    'store_identity_unique', exists (
      select 1 from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'stores_continente_identity_key' and i.indisunique and i.indisvalid
    ),
    'price_identity_unique', exists (
      select 1 from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'prices_continente_identity_key' and i.indisunique and i.indisvalid
    )
  );
$$;
revoke all on function public.continente_sync_capabilities() from public, anon, authenticated;
grant execute on function public.continente_sync_capabilities() to service_role;
notify pgrst, 'reload schema';
commit;