-- =============================================
-- JONY KIDS HR — Supabase SQL Setup
-- Supabase SQL Editor'da TO'LIQ ishga tushiring. Qayta ishga tushirish xavfsiz (idempotent).
--
-- Tartib (mavjud baza uchun):
--   1) shu fayl
--   2) Edge Function: supabase/functions/admin-users  (deploy)
--   3) node scripts/migrate-users.mjs                 (foydalanuvchilarni Auth'ga ko'chirish)
--   4) supabase_finalize.sql                          (ochiq parollarni o'chirish)
--   5) yangi index.html / app.js / styles.css / sw.js ni joylash
--
-- DIQQAT: "Talabalar" bo'limi olib tashlangan — students, teachers, groups jadvallari
-- shu fayl orqali BUTUNLAY O'CHIRILADI. Ishga tushirishdan oldin zaxira nusxa oling.
-- =============================================

create extension if not exists pgcrypto;

-- =============================================
-- "TALABALAR" BO'LIMINI O'CHIRISH
-- =============================================
drop table if exists students cascade;
drop table if exists teachers cascade;
drop table if exists groups cascade;

-- =============================================
-- JADVALLAR
-- =============================================
create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  lat double precision,
  lng double precision,
  radius integer default 100,
  created_at timestamptz default now()
);

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  login text unique not null,
  password text,               -- ESKI: supabase_finalize.sql o'chiradi
  role text default 'staff',   -- staff | admin
  position text,
  branch_id uuid references branches(id) on delete set null,
  branch_name text,
  shifts jsonb default '[]',   -- [{"start":"08:00","end":"17:00","days":[1,2,3]}]
  permissions jsonb default '{}',
  created_at timestamptz default now()
);

create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  login text unique not null,
  password text,               -- ESKI: supabase_finalize.sql o'chiradi
  permissions jsonb default '{"_v":2}',
  created_at timestamptz default now()
);

create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id) on delete set null,
  staff_name text,
  branch_id uuid references branches(id) on delete set null,
  branch_name text,
  type text not null, -- checkin | checkout
  time timestamptz not null default now(),
  late_minutes integer default 0,
  lat double precision,
  lng double precision,
  created_at timestamptz default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  type text default 'task', -- task | note | alert | fine | discipline
  assigned_to uuid references staff(id),
  assigned_name text,
  deadline timestamptz,
  created_by text,
  replies jsonb default '[]',
  created_at timestamptz default now()
);

create table if not exists app_tags (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  label text not null,
  sort integer default 0,
  created_at timestamptz default now()
);

-- Jarima sozlamalari (bitta qator)
create table if not exists penalty_settings (
  id int primary key default 1 check (id = 1),
  unit text not null default 'minute' check (unit in ('second', 'minute', 'hour')),
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  currency text not null default 'UZS' check (length(btrim(currency)) between 1 and 10),
  -- Intizomiy chora chegaralari (kechikish daqiqalarida):
  -- [1, warning_from) Bildirishnoma, [warning_from, reprimand_from) Ogohlantirish,
  -- [reprimand_from, severe_from) Tanbeh, [severe_from, ∞) Qattiq tanbeh
  warning_from int not null default 6,
  reprimand_from int not null default 16,
  severe_from int not null default 31,
  updated_at timestamptz default now(),
  constraint penalty_thresholds_ok check (warning_from >= 2 and warning_from < reprimand_from and reprimand_from < severe_from)
);
insert into penalty_settings (id) values (1) on conflict (id) do nothing;

-- Har bir kechikish uchun qo'llangan jarima / intizomiy chora (tarix)
create table if not exists penalties (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid references attendance(id) on delete set null,
  staff_id uuid references staff(id) on delete set null,
  staff_name text,
  kind text not null check (kind in ('fine', 'discipline')),
  level text check (level in ('notice', 'warning', 'reprimand', 'severe')),
  late_seconds int not null,
  late_minutes int not null,
  late_at timestamptz not null,   -- kelgan vaqt
  shift_start text,               -- '09:00'
  unit text,
  unit_amount numeric(14, 2),
  units int,
  amount numeric(14, 2) not null default 0,
  currency text,
  task_id uuid references tasks(id) on delete set null,
  created_at timestamptz default now()
);

-- =============================================
-- USTUNLAR (migratsiya)
-- =============================================
alter table branches add column if not exists lat double precision;
alter table branches add column if not exists lng double precision;
alter table branches add column if not exists radius integer default 100;
alter table attendance add column if not exists lat double precision;
alter table attendance add column if not exists lng double precision;
alter table attendance add column if not exists late_reason text;
alter table attendance add column if not exists late_comment text;
alter table attendance add column if not exists auto_closed boolean not null default false;
alter table attendance add column if not exists late_seconds integer not null default 0;
-- Kelgan kuni xodimga smena belgilanmagan (kechikishni hisoblab bo'lmaydi) — "Vaqtida" emas, "Smena yo'q" ko'rsatiladi
alter table attendance add column if not exists no_shift boolean not null default false;
-- Qo'lda belgilangan davomat (izoh majburiy) va ruxsat bilan surilgan ish boshlanishi
alter table attendance add column if not exists manual boolean not null default false;
alter table attendance add column if not exists manual_comment text;
alter table attendance add column if not exists manual_by text;
alter table attendance add column if not exists permit_until text;
alter table attendance add column if not exists permit_comment text;
-- O'chirilgan davomat: yozuv bazada qoladi (tarix), lekin ro'yxat, hisobot va hisob-kitoblarda ko'rinmaydi
alter table attendance add column if not exists deleted boolean not null default false;
alter table attendance add column if not exists deleted_at timestamptz;
alter table attendance add column if not exists deleted_by text;
alter table attendance add column if not exists delete_reason text;

-- Kechikishga ruxsat: xodimning ma'lum kundagi ish boshlanishi belgilangan vaqtgacha suriladi
create table if not exists attendance_permits (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id) on delete cascade,
  staff_name text,
  permit_date date not null,
  allowed_until time not null,
  comment text not null,
  created_by text,
  created_at timestamptz default now(),
  cancelled boolean not null default false,
  cancelled_by text,
  cancelled_at timestamptz
);
create unique index if not exists permits_active_uidx on attendance_permits (staff_id, permit_date) where not cancelled;
create index if not exists permits_date_idx on attendance_permits (permit_date desc);
update attendance set late_seconds = late_minutes * 60 where late_seconds = 0 and coalesce(late_minutes, 0) > 0;
alter table tasks add column if not exists done boolean default false;

-- Supabase Auth bilan bog'lash
alter table staff  add column if not exists user_id uuid unique references auth.users(id) on delete set null;
alter table admins add column if not exists user_id uuid unique references auth.users(id) on delete set null;
alter table admins add column if not exists is_super boolean not null default false;

-- Jarima tizimiga kiritilgan xodim (faqat Super Admin belgilaydi)
alter table staff add column if not exists penalty_enabled boolean not null default false;

-- Muzlatish: jami kechikish chegaradan oshsa xodim profili muzlatiladi.
-- Kechikishlar late_counter_from dan boshlab yig'iladi (funksiya yoqilgan payt yoki oxirgi muzlatishdan chiqarilgan payt)
alter table staff add column if not exists frozen boolean not null default false;
alter table staff add column if not exists frozen_at timestamptz;
alter table staff add column if not exists frozen_late_seconds int;
alter table staff add column if not exists frozen_limit_minutes int;
alter table staff add column if not exists late_counter_from timestamptz not null default now();
alter table penalty_settings add column if not exists freeze_limit_minutes int not null default 1440;
do $$ begin
  alter table penalty_settings add constraint penalty_freeze_limit_ok check (freeze_limit_minutes between 1 and 525600);
exception when duplicate_object then null;
end $$;

-- Parol endi majburiy emas (Auth'da saqlanadi)
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='staff' and column_name='password') then
    alter table staff alter column password drop not null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='admins' and column_name='password') then
    alter table admins alter column password drop not null;
  end if;
end $$;

-- Eski kod smenalarni JSON-satr sifatida saqlagan — massivga aylantiramiz
update staff set shifts = (shifts #>> '{}')::jsonb where jsonb_typeof(shifts) = 'string';

-- Talaba holatlariga oid teglar endi kerak emas
delete from app_tags where kind <> 'late';

-- FK: xodim o'chirilganda davomat va jarima TARIXI saqlanadi (staff_id NULL bo'ladi, ism qoladi)
alter table attendance drop constraint if exists attendance_staff_id_fkey;
alter table attendance add constraint attendance_staff_id_fkey foreign key (staff_id) references staff(id) on delete set null;
alter table attendance drop constraint if exists attendance_branch_id_fkey;
alter table attendance add constraint attendance_branch_id_fkey foreign key (branch_id) references branches(id) on delete set null;
alter table staff drop constraint if exists staff_branch_id_fkey;
alter table staff add constraint staff_branch_id_fkey foreign key (branch_id) references branches(id) on delete set null;
-- Xodim o'chsa unga berilgan vazifalar ham o'chadi (avval FK xatosi tufayli xodimni o'chirib bo'lmasdi)
alter table tasks drop constraint if exists tasks_assigned_to_fkey;
alter table tasks add constraint tasks_assigned_to_fkey foreign key (assigned_to) references staff(id) on delete cascade;

create index if not exists attendance_staff_time_idx on attendance (staff_id, time desc);
create index if not exists attendance_time_idx on attendance (time desc);
create index if not exists tasks_assigned_idx on tasks (assigned_to);
create unique index if not exists penalties_attendance_uidx on penalties (attendance_id) where attendance_id is not null;
create index if not exists penalties_staff_time_idx on penalties (staff_id, late_at desc);
create index if not exists penalties_time_idx on penalties (late_at desc);

-- Jarimani / intizomiy chorani bekor qilish (yozuv o'chirilmaydi, tarix saqlanadi)
alter table penalties add column if not exists cancelled boolean not null default false;
alter table penalties add column if not exists cancelled_at timestamptz;
alter table penalties add column if not exists cancelled_by text;
alter table penalties add column if not exists cancel_reason text;
create index if not exists penalties_task_idx on penalties (task_id);

-- =============================================
-- RUXSATLAR (multi-permission)
-- Admin faqat aniq "true" qilib berilgan ruxsatlarga ega. Super Admin — hammasiga.
-- =============================================
create or replace function public.permission_keys() returns text[]
language sql immutable as $$
  select array[
    'dashboard', 'dashboard_late', 'dashboard_absent', 'dashboard_penalties',
    'attendance', 'attendance_edit', 'reports',
    'tasks_view', 'tasks_manage',
    'staff_view', 'staff_manage', 'branches',
    'penalty_settings', 'staff_freeze', 'penalty_cancel', 'attendance_permit', 'attendance_delete'
  ]
$$;

-- Eski ruxsatlarni (add_staff/tasks/reports/students, "kalit yo'q = ruxsat bor") yangi
-- aniq ro'yxatga bir marta ko'chirish. Avval hamma admin ko'rgan bo'limlar saqlanib qoladi.
update admins set permissions = jsonb_build_object(
  '_v', 2,
  'dashboard', true, 'dashboard_late', true, 'dashboard_absent', true,
  'dashboard_penalties', coalesce(permissions ->> 'reports', 'true') <> 'false',
  'attendance', true, 'attendance_edit', true,
  'reports', coalesce(permissions ->> 'reports', 'true') <> 'false',
  'tasks_view', true,
  'tasks_manage', coalesce(permissions ->> 'tasks', 'true') <> 'false',
  'staff_view', true,
  'staff_manage', coalesce(permissions ->> 'add_staff', 'true') <> 'false',
  'branches', coalesce(permissions ->> 'add_staff', 'true') <> 'false',
  'penalty_settings', false)
where not is_super and not (coalesce(permissions, '{}'::jsonb) ? '_v');

-- =============================================
-- YORDAMCHI FUNKSIYALAR (rol aniqlash)
-- =============================================
create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from admins where user_id = auth.uid() and is_super) then 'superadmin'
    when exists (select 1 from admins where user_id = auth.uid()) then 'admin'
    when exists (select 1 from staff  where user_id = auth.uid() and role = 'admin') then 'admin'
    when exists (select 1 from staff  where user_id = auth.uid()) then 'staff'
  end
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() in ('admin', 'superadmin'), false)
$$;

create or replace function public.admin_can(perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins
    where user_id = auth.uid()
      and (is_super or coalesce(permissions ->> perm, 'false') = 'true')
  ) or exists (
    select 1 from staff
    where user_id = auth.uid() and role = 'admin'
      and coalesce(permissions ->> perm, 'false') = 'true'
  )
$$;

create or replace function public.admin_can_any(perms text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(public.admin_can(p)), false) from unnest(perms) p
$$;

-- Muzlatilgan xodim hech qanday ma'lumot ko'rmaydi va amal bajara olmaydi
create or replace function public.my_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where user_id = auth.uid() and not frozen
$$;

-- Joriy foydalanuvchi profili. NULL — akkaunt yo'q yoki o'chirilgan (klient chiqarib yuboradi)
create or replace function public.whoami() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a admins; s staff;
begin
  if auth.uid() is null then return null; end if;
  select * into a from admins where user_id = auth.uid();
  if found then
    return jsonb_build_object(
      'id', a.id, 'name', a.name, 'login', a.login, 'kind', 'admin',
      'role', case when a.is_super then 'superadmin' else 'admin' end,
      'permissions', coalesce(a.permissions, '{}'::jsonb));
  end if;
  select * into s from staff where user_id = auth.uid();
  if found then
    return jsonb_build_object(
      'id', s.id, 'name', s.name, 'login', s.login, 'kind', 'staff',
      'role', coalesce(nullif(s.role, ''), 'staff'),
      'permissions', coalesce(s.permissions, '{}'::jsonb),
      'position', s.position, 'branch_id', s.branch_id, 'branch_name', s.branch_name,
      'shifts', s.shifts, 'penalty_enabled', s.penalty_enabled,
      'frozen', s.frozen,
      'freeze_message', case when s.frozen then public.freeze_message(s.name, s.frozen_limit_minutes) end);
  end if;
  return null;
end $$;

create or replace function public.update_my_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTH' using errcode = '42501'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or length(p_name) > 120 then raise exception 'BAD_NAME'; end if;
  update admins set name = p_name where user_id = auth.uid();
  update staff  set name = p_name where user_id = auth.uid();
end $$;

-- Super Admin: admin ruxsatlarini o'zgartirish (bir nechta ruxsat bir vaqtda)
create or replace function public.set_admin_permissions(p_admin uuid, p_perms jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if public.app_role() is distinct from 'superadmin' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if exists (select 1 from admins where id = p_admin and is_super) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select coalesce(jsonb_object_agg(k, true), '{}'::jsonb) into v
    from unnest(public.permission_keys()) k
   where coalesce(p_perms ->> k, 'false') = 'true';
  v := v || '{"_v":2}'::jsonb;
  update admins set permissions = v where id = p_admin;
  if not found then raise exception 'NOT_FOUND'; end if;
  return v;
end $$;

-- Super Admin: xodimni jarima tizimiga kiritish / chiqarish
create or replace function public.set_staff_penalty(p_staff uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.app_role() is distinct from 'superadmin' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update staff set penalty_enabled = coalesce(p_enabled, false) where id = p_staff;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

-- =============================================
-- DAVOMAT HISOBI (serverda — klientni aldab bo'lmaydi)
-- =============================================
create or replace function public.distance_m(lat1 float8, lon1 float8, lat2 float8, lon2 float8) returns float8
language sql immutable as $$
  select 6371000 * 2 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2))))
$$;

-- Kelgan vaqtga tegishli smena (o'sha hafta kuni uchun). Tartib:
--   1) hozir davom etayotgan smena (boshlangan, hali tugamagan) — bir nechta bo'lsa eng kech boshlangani;
--   2) bo'lmasa — hali boshlanmagan eng yaqin smena (xodim erta keldi → kechikish yo'q);
--   3) bo'lmasa — bugungi smenalarning eng oxirgisi (hammasi tugagandan keyin keldi).
-- Avval "boshlanishi eng yaqin" smena olinardi: 09:00–13:00 va 14:00–18:00 smenali xodim
-- 11:40 da kelsa, 14:00 smenasiga "erta keldi" deb hisoblanib, kechikish 0 chiqardi.
-- start_min — smena boshlanishi (daqiqa), dur_min — davomiyligi (end yo'q bo'lsa NULL, oyna 4 soat deb olinadi)
create or replace function public.pick_shift(p_shifts jsonb, p_local timestamp)
returns table (start_min int, dur_min int)
language plpgsql immutable as $$
declare
  arr jsonb := p_shifts;
  sh jsonb;
  v_dow int := extract(dow from p_local)::int;
  v_hm int := extract(hour from p_local)::int * 60 + extract(minute from p_local)::int;
  s int; e int; d int; w_end int;
  in_s int; in_d int;                  -- davom etayotgan smena
  up_s int; up_d int;                  -- boshlanmagan eng yaqin smena
  last_s int; last_d int; last_end int; -- tugagan smenalardan eng kech tugagani
begin
  if arr is null then return; end if;
  if jsonb_typeof(arr) = 'string' then arr := (arr #>> '{}')::jsonb; end if;
  if jsonb_typeof(arr) <> 'array' then return; end if;
  for sh in select value from jsonb_array_elements(arr) loop
    if coalesce(sh ->> 'start', '') !~ '^\d{1,2}:\d{2}' then continue; end if;
    if jsonb_typeof(sh -> 'days') = 'array' and jsonb_array_length(sh -> 'days') > 0
       and not exists (select 1 from jsonb_array_elements_text(sh -> 'days') x(v) where btrim(v) = v_dow::text) then
      continue;
    end if;
    s := split_part(sh ->> 'start', ':', 1)::int * 60 + split_part(sh ->> 'start', ':', 2)::int;
    d := null;
    if coalesce(sh ->> 'end', '') ~ '^\d{1,2}:\d{2}' then
      e := split_part(sh ->> 'end', ':', 1)::int * 60 + split_part(sh ->> 'end', ':', 2)::int;
      d := e - s;
      if d <= 0 then d := d + 1440; end if;  -- yarim tundan o'tadigan smena
    end if;
    w_end := s + coalesce(d, 240);
    if v_hm >= s and v_hm < w_end then
      if in_s is null or s > in_s then in_s := s; in_d := d; end if;
    elsif v_hm < s then
      if up_s is null or s < up_s then up_s := s; up_d := d; end if;
    elsif last_end is null or w_end > last_end then
      last_end := w_end; last_s := s; last_d := d;
    end if;
  end loop;
  if in_s is not null then start_min := in_s; dur_min := in_d; return next;
  elsif up_s is not null then start_min := up_s; dur_min := up_d; return next;
  elsif last_s is not null then start_min := last_s; dur_min := last_d; return next;
  end if;
end $$;

-- Kechikish (soniyalarda) va tegishli smena boshlanishi. Kechikish = kelgan vaqt − eng yaqin smena boshi.
-- late_minutes = late_seconds / 60 (to'liq daqiqalar) — avvalgi hisob bilan bir xil.
create or replace function public.lateness_for(p_shifts jsonb, p_time timestamptz)
returns table (late_seconds int, shift_start_min int)
language plpgsql stable as $$
declare v_local timestamp := p_time at time zone 'Asia/Tashkent'; sh record; v_sec int;
begin
  select * into sh from public.pick_shift(p_shifts, v_local);
  if not found then
    late_seconds := 0; shift_start_min := null; return next; return;
  end if;
  v_sec := extract(hour from v_local)::int * 3600 + extract(minute from v_local)::int * 60
           + floor(extract(second from v_local))::int;
  late_seconds := greatest(0, v_sec - sh.start_min * 60);
  shift_start_min := sh.start_min;
  return next;
end $$;
drop function if exists public.late_minutes_for(jsonb, timestamptz);

-- Kechikish + shu kunga berilgan ruxsat. Ruxsat vaqti tanlangan smena oralig'ida bo'lsa,
-- ish boshlanishi o'sha vaqtga suriladi (shu vaqtgacha kelsa — kechikish yo'q).
create or replace function public.lateness_with_permit(p_staff_id uuid, p_shifts jsonb, p_time timestamptz)
returns table (late_seconds int, shift_start_min int, permit_until text, permit_comment text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_local timestamp := p_time at time zone 'Asia/Tashkent';
  sh record; pm attendance_permits; v_start int; v_until int; v_sec int;
begin
  permit_until := null; permit_comment := null;
  select * into sh from public.pick_shift(p_shifts, v_local);
  if not found then
    late_seconds := 0; shift_start_min := null; return next; return;
  end if;
  v_start := sh.start_min;
  select * into pm from attendance_permits
   where staff_id = p_staff_id and permit_date = v_local::date and not cancelled
   order by created_at desc limit 1;
  if found then
    v_until := extract(hour from pm.allowed_until)::int * 60 + extract(minute from pm.allowed_until)::int;
    if v_until > v_start and v_until < v_start + coalesce(sh.dur_min, 240) then
      v_start := v_until;
      permit_until := to_char(pm.allowed_until, 'HH24:MI');
      permit_comment := pm.comment;
    end if;
  end if;
  v_sec := extract(hour from v_local)::int * 3600 + extract(minute from v_local)::int * 60
           + floor(extract(second from v_local))::int;
  late_seconds := greatest(0, v_sec - v_start * 60);
  shift_start_min := v_start;
  return next;
end $$;

-- Matn yordamchilari (bildirishnoma matni uchun)
create or replace function public.fmt_money(x numeric) returns text
language sql immutable as $$
  select regexp_replace(split_part(t, '.', 1), '(\d)(?=(\d{3})+$)', '\1 ', 'g')
         || case when split_part(t, '.', 2) <> '' then ',' || split_part(t, '.', 2) else '' end
  from (select rtrim(rtrim(to_char(round(coalesce(x, 0), 2), 'FM999999999990.00'), '0'), '.') as t) q
$$;

create or replace function public.fmt_late(p_sec int) returns text
language sql immutable as $$
  select concat_ws(' ',
    case when p_sec >= 3600 then (p_sec / 3600) || ' soat' end,
    case when (p_sec % 3600) / 60 > 0 then ((p_sec % 3600) / 60) || ' daqiqa' end,
    case when p_sec % 60 > 0 or p_sec = 0 then (p_sec % 60) || ' soniya' end)
$$;

create or replace function public.discipline_label(p_level text) returns text
language sql immutable as $$
  select case p_level
    when 'notice' then 'Bildirishnoma' when 'warning' then 'Ogohlantirish'
    when 'reprimand' then 'Tanbeh' when 'severe' then 'Qattiq tanbeh' end
$$;

-- =============================================
-- MUZLATISH (jami kechikish chegarasi)
-- =============================================
create or replace function public.freeze_message(p_name text, p_limit_minutes int) returns text
language sql immutable as $$
  select 'Hurmatli ' || coalesce(p_name, 'xodim') || ', sizning ish vaqtiga kechikishlaringiz miqdori belgilangan '
         || public.fmt_late(coalesce(p_limit_minutes, 0) * 60)
         || 'dan oshib ketgani uchun lavozimingizdan bo''shatildingiz, amaldagi lavozimingiz va profillaringiz muzlatildi. '
         || 'Holat bo''yicha rahbariyatga aloqaga chiqing.'
$$;

-- Xodimning jami kechikishini tekshiradi; chegaraga yetgan bo'lsa profilni muzlatadi
create or replace function public.check_freeze(p_staff_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s staff; v_limit int; v_total bigint;
begin
  select * into s from staff where id = p_staff_id for update;
  if not found or s.frozen then return null; end if;
  select freeze_limit_minutes into v_limit from penalty_settings where id = 1;
  select coalesce(sum(late_seconds), 0) into v_total
    from attendance
   where staff_id = s.id and type = 'checkin' and not deleted and time >= s.late_counter_from;
  if v_limit is null or v_total < v_limit::bigint * 60 then return null; end if;
  update staff
     set frozen = true, frozen_at = now(), frozen_late_seconds = least(v_total, 2147483647)::int, frozen_limit_minutes = v_limit
   where id = s.id;
  return jsonb_build_object('frozen', true, 'limit_minutes', v_limit, 'late_seconds', v_total,
                            'message', public.freeze_message(s.name, v_limit));
end $$;

-- Ruxsati bor admin: muzlatishdan chiqarish (kechikish hisoblagichi noldan boshlanadi)
create or replace function public.unfreeze_staff(p_staff uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.admin_can('staff_freeze') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update staff
     set frozen = false, frozen_at = null, frozen_late_seconds = null, frozen_limit_minutes = null,
         late_counter_from = now()
   where id = p_staff and frozen;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

-- Ruxsati bor admin: muzlatish chegarasini o'zgartirish (daqiqalarda)
create or replace function public.set_freeze_limit(p_minutes int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.admin_can('staff_freeze') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 525600 then raise exception 'BAD_LIMIT'; end if;
  update penalty_settings set freeze_limit_minutes = p_minutes, updated_at = now() where id = 1;
end $$;

-- Adminlar uchun: har bir xodimning joriy hisoblagichdagi jami kechikishi (soniya)
create or replace function public.staff_late_totals() returns table (staff_id uuid, late_seconds bigint)
language sql stable security definer set search_path = public as $$
  select s.id, coalesce(sum(a.late_seconds), 0)::bigint
    from staff s
    left join attendance a on a.staff_id = s.id and a.type = 'checkin' and not a.deleted and a.time >= s.late_counter_from
   where public.is_admin()
   group by s.id
$$;

-- Chegarani faqat "staff_freeze" ruxsati bilan o'zgartirish mumkin (penalty_settings jadvalini to'g'ridan-to'g'ri yangilaganda ham)
create or replace function public.penset_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.freeze_limit_minutes is distinct from old.freeze_limit_minutes
     and auth.uid() is not null and not public.admin_can('staff_freeze') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists penset_guard on penalty_settings;
create trigger penset_guard before update on penalty_settings for each row execute function public.penset_guard();

-- Kechikish aniqlanganda: jarima (jarima tizimidagi xodim) yoki intizomiy chora (qolganlar).
-- Natija penalties jadvaliga yoziladi va xodimning Vazifalar paneliga bildirishnoma yuboriladi.
create or replace function public.apply_lateness(p_att attendance, p_staff staff, p_shift_start int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg penalty_settings;
  v_level text; v_kind text; v_unit_sec int; v_units int := null; v_amount numeric := 0;
  v_local timestamp := p_att.time at time zone 'Asia/Tashkent';
  v_month_from timestamptz; m_days int; m_sec bigint; m_amount numeric;
  v_pen_id uuid; v_task_id uuid; v_title text; v_body text; v_shift text; v_unit_lbl text;
  v_dows text[] := array['Yakshanba','Dushanba','Seshanba','Chorshanba','Payshanba','Juma','Shanba'];
  v_mons text[] := array['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentyabr','Oktyabr','Noyabr','Dekabr'];
begin
  if p_att.type <> 'checkin' or coalesce(p_att.late_minutes, 0) <= 0 or p_staff.id is null then return null; end if;
  select * into cfg from penalty_settings where id = 1;

  -- Intizomiy daraja — kechikish davomiyligiga qarab
  v_level := case
    when p_att.late_minutes >= cfg.severe_from then 'severe'
    when p_att.late_minutes >= cfg.reprimand_from then 'reprimand'
    when p_att.late_minutes >= cfg.warning_from then 'warning'
    else 'notice' end;

  v_unit_lbl := case cfg.unit when 'second' then 'soniya' when 'hour' then 'soat' else 'daqiqa' end;
  if p_staff.penalty_enabled then
    v_kind := 'fine';
    v_unit_sec := case cfg.unit when 'second' then 1 when 'hour' then 3600 else 60 end;
    v_units := p_att.late_seconds / v_unit_sec;          -- to'liq birliklar soni
    v_amount := v_units * cfg.amount;
    -- Jarima tizimidagi xodimga faqat Tanbeh / Qattiq tanbeh qo'shimcha ko'rsatiladi
    if v_level not in ('reprimand', 'severe') then v_level := null; end if;
  else
    v_kind := 'discipline';
  end if;

  v_shift := case when p_shift_start is not null
    then lpad((p_shift_start / 60)::text, 2, '0') || ':' || lpad((p_shift_start % 60)::text, 2, '0') end;

  insert into penalties (attendance_id, staff_id, staff_name, kind, level, late_seconds, late_minutes, late_at,
                         shift_start, unit, unit_amount, units, amount, currency)
  values (p_att.id, p_staff.id, p_staff.name, v_kind, v_level, p_att.late_seconds, p_att.late_minutes, p_att.time,
          v_shift,
          case when v_kind = 'fine' then cfg.unit end,
          case when v_kind = 'fine' then cfg.amount end,
          v_units, v_amount,
          case when v_kind = 'fine' then cfg.currency end)
  on conflict (attendance_id) where attendance_id is not null do nothing
  returning id into v_pen_id;
  if v_pen_id is null then return null; end if;

  -- Oy bo'yicha jamlanma (kun / daqiqa / summa kesimida)
  v_month_from := date_trunc('month', v_local) at time zone 'Asia/Tashkent';
  select count(distinct (late_at at time zone 'Asia/Tashkent')::date),
         coalesce(sum(late_seconds), 0),
         coalesce(sum(amount) filter (where kind = 'fine' and currency = cfg.currency), 0)
    into m_days, m_sec, m_amount
    from penalties
   where staff_id = p_staff.id and not cancelled and late_at >= v_month_from and late_at < v_month_from + interval '1 month';

  if v_kind = 'fine' then
    v_title := 'Jarima: ' || fmt_money(v_amount) || ' ' || cfg.currency || ' — ' || fmt_late(p_att.late_seconds) || ' kechikish'
               || coalesce(' · ' || discipline_label(v_level), '');
  else
    v_title := discipline_label(v_level) || ' — ' || fmt_late(p_att.late_seconds) || ' kechikish';
  end if;

  v_body := concat_ws(E'\n',
    'Kun: ' || to_char(v_local, 'DD.MM.YYYY') || ', ' || v_dows[extract(dow from v_local)::int + 1],
    case when v_shift is not null then 'Ish boshlanishi: ' || v_shift
      || case when p_att.permit_until is not null then ' (ruxsat bilan surilgan)' else '' end end,
    case when p_att.permit_until is not null then 'Ruxsat izohi: ' || p_att.permit_comment end,
    case when p_att.manual then 'Qo''lda belgilandi (' || coalesce(p_att.manual_by, 'admin') || '): ' || coalesce(p_att.manual_comment, '') end,
    'Kelgan vaqt: ' || to_char(v_local, 'HH24:MI:SS'),
    'Kechikish: ' || fmt_late(p_att.late_seconds) || ' (' || p_att.late_minutes || ' daqiqa)',
    case when v_kind = 'fine' then
      'Hisob: ' || v_units || ' ' || v_unit_lbl || ' × ' || fmt_money(cfg.amount) || ' ' || cfg.currency
      || ' = ' || fmt_money(v_amount) || ' ' || cfg.currency end,
    case when v_level is not null then 'Intizomiy chora: ' || discipline_label(v_level) end,
    v_mons[extract(month from v_local)::int] || ' ' || extract(year from v_local)::int || ' bo''yicha: '
      || m_days || ' kun kechikkan, jami ' || fmt_late(m_sec::int)
      || case when v_kind = 'fine' then ', jami jarima ' || fmt_money(m_amount) || ' ' || cfg.currency else '' end);

  insert into tasks (title, body, type, assigned_to, assigned_name, created_by, replies, done)
  values (v_title, v_body, v_kind, p_staff.id, p_staff.name, 'system', '[]'::jsonb, false)
  returning id into v_task_id;
  update penalties set task_id = v_task_id where id = v_pen_id;

  return jsonb_build_object(
    'id', v_pen_id, 'kind', v_kind, 'level', v_level, 'amount', v_amount, 'currency', cfg.currency,
    'late_seconds', p_att.late_seconds, 'late_minutes', p_att.late_minutes,
    'title', v_title, 'body', v_body, 'task_id', v_task_id);
end $$;

-- Ruxsati bor admin: berilgan jarima / intizomiy chorani bekor qilish (sabab majburiy).
-- Asl bildirishnoma "Bekor qilingan" deb belgilanadi va xodimga yangi bildirishnoma yuboriladi.
create or replace function public.cancel_penalty(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.admin_can('penalty_cancel') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  p_reason := btrim(coalesce(p_reason, ''));
  if p_reason = '' then raise exception 'NEED_REASON'; end if;
  return public.do_cancel_penalty(p_id, p_reason);
end $$;

-- Ichki: jarimani bekor qilish (ruxsat tekshiruvi chaqiruvchida)
create or replace function public.do_cancel_penalty(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pen penalties; v_by text; v_what text; v_now text;
begin
  select * into pen from penalties where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if pen.cancelled then raise exception 'ALREADY_CANCELLED'; end if;

  v_by := coalesce((select name from admins where user_id = auth.uid()),
                   (select name from staff where user_id = auth.uid()), 'Admin');
  v_now := to_char(now() at time zone 'Asia/Tashkent', 'DD.MM.YYYY HH24:MI');
  update penalties
     set cancelled = true, cancelled_at = now(), cancelled_by = v_by, cancel_reason = left(p_reason, 500)
   where id = pen.id;

  v_what := case when pen.kind = 'fine'
    then 'Jarima (' || fmt_money(pen.amount) || ' ' || coalesce(pen.currency, '') || ')'
    else coalesce(discipline_label(pen.level), 'Intizomiy chora') end;

  if pen.task_id is not null then
    update tasks
       set title = 'Bekor qilingan · ' || title,
           body  = coalesce(body, '') || E'\n\nBekor qilindi: ' || v_now || ' (' || v_by || ')' || E'\nSabab: ' || left(p_reason, 500)
     where id = pen.task_id and title not like 'Bekor qilingan%';
  end if;

  if pen.staff_id is not null then
    insert into tasks (title, body, type, assigned_to, assigned_name, created_by, replies, done)
    values (v_what || ' bekor qilindi',
            concat_ws(E'\n',
              'Kechikish kuni: ' || to_char(pen.late_at at time zone 'Asia/Tashkent', 'DD.MM.YYYY HH24:MI'),
              'Kechikish: ' || fmt_late(pen.late_seconds),
              'Bekor qilindi: ' || v_now || ' (' || v_by || ')',
              'Sabab: ' || left(p_reason, 500)),
            pen.kind, pen.staff_id, pen.staff_name, 'system', '[]'::jsonb, false);
  end if;

  return jsonb_build_object('id', pen.id, 'cancelled', true, 'cancelled_by', v_by);
end $$;

-- Ruxsati bor admin: davomat yozuvini o'chirish (izoh majburiy).
-- Yozuv bazada "o'chirilgan" deb qoladi; unga bog'langan jarima avtomatik bekor qilinadi; xodimga xabar boradi.
create or replace function public.delete_attendance(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a attendance; v_by text; v_pen uuid; v_pen_cancelled boolean := false;
begin
  if not public.admin_can('attendance_delete') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  p_reason := btrim(coalesce(p_reason, ''));
  if p_reason = '' then raise exception 'NEED_COMMENT'; end if;
  select * into a from attendance where id = p_id for update;
  if not found or a.deleted then raise exception 'NOT_FOUND'; end if;

  v_by := coalesce((select name from admins where user_id = auth.uid()),
                   (select name from staff where user_id = auth.uid()), 'Admin');
  update attendance
     set deleted = true, deleted_at = now(), deleted_by = v_by, delete_reason = left(p_reason, 500)
   where id = a.id;

  select id into v_pen from penalties where attendance_id = a.id and not cancelled;
  if v_pen is not null then
    perform public.do_cancel_penalty(v_pen, 'Davomat yozuvi o''chirildi: ' || p_reason);
    v_pen_cancelled := true;
  end if;

  if a.staff_id is not null then
    insert into tasks (title, body, type, assigned_to, assigned_name, created_by, replies, done)
    values ('Davomat yozuvi o''chirildi: ' || to_char(a.time at time zone 'Asia/Tashkent', 'DD.MM.YYYY HH24:MI'),
            concat_ws(E'\n',
              to_char(a.time at time zone 'Asia/Tashkent', 'DD.MM.YYYY HH24:MI')
                || ' — ' || case when a.type = 'checkin' then 'Keldim' else 'Ketdim' end
                || coalesce(' (' || a.branch_name || ')', ''),
              'O''chirdi: ' || v_by,
              'Sabab: ' || left(p_reason, 500),
              case when v_pen_cancelled then 'Shu yozuvga bog''liq jarima / chora bekor qilindi.' end),
            'note', a.staff_id, a.staff_name, 'system', '[]'::jsonb, false);
  end if;

  return jsonb_build_object('id', a.id, 'deleted', true, 'penalty_cancelled', v_pen_cancelled);
end $$;

-- Unutilgan Ketdim'ni avtomatik yopish (smena tugashi + 60 daqiqadan keyin)
create or replace function public.close_my_stale_session() returns boolean
language plpgsql security definer set search_path = public as $$
declare s staff; v_last attendance; sh record; v_out timestamptz;
begin
  select * into s from staff where user_id = auth.uid();
  if not found then return false; end if;
  perform pg_advisory_xact_lock(hashtext('att:' || s.id::text));
  select * into v_last from attendance where staff_id = s.id and not deleted order by time desc limit 1;
  if v_last.id is null or v_last.type <> 'checkin' then return false; end if;
  select * into sh from public.pick_shift(s.shifts, v_last.time at time zone 'Asia/Tashkent');
  if not found or sh.dur_min is null then return false; end if;
  v_out := v_last.time + make_interval(mins => sh.dur_min);
  if now() < v_out + interval '60 minutes' then return false; end if;
  insert into attendance (staff_id, staff_name, branch_id, branch_name, type, time, late_minutes, auto_closed)
  values (s.id, s.name, v_last.branch_id, v_last.branch_name, 'checkout', v_out, 0, true);
  return true;
end $$;

-- Xodim "Keldim"/"Ketdim": GPS, filial, tartib, kechikish va jarima SERVERDA hisoblanadi.
-- Qaytaradi: { attendance, penalty } (penalty — kechikmagan bo'lsa null)
drop function if exists public.staff_check(text, float8, float8, uuid);
create function public.staff_check(p_type text, p_lat float8, p_lng float8, p_branch_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s staff; b branches; v_last attendance; rec attendance;
  v_today date := (now() at time zone 'Asia/Tashkent')::date;
  v_open boolean; v_late int := 0; v_shift int; v_pen jsonb; v_frz jsonb; v_pu text; v_pc text;
begin
  select * into s from staff where user_id = auth.uid();
  if not found then raise exception 'NOT_STAFF' using errcode = '42501'; end if;
  if s.frozen then raise exception 'FROZEN' using errcode = '42501'; end if;
  if p_type not in ('checkin', 'checkout') then raise exception 'BAD_TYPE'; end if;
  if p_lat is null or p_lng is null then raise exception 'NO_GPS'; end if;

  perform public.close_my_stale_session();
  perform pg_advisory_xact_lock(hashtext('att:' || s.id::text));

  select * into v_last from attendance where staff_id = s.id and not deleted order by time desc limit 1;
  v_open := v_last.id is not null and v_last.type = 'checkin'
            and (v_last.time at time zone 'Asia/Tashkent')::date = v_today;

  if p_type = 'checkin' then
    if v_open then raise exception 'ALREADY_IN'; end if;
    select * into b from branches where id = p_branch_id;
  else
    if not v_open then raise exception 'NOT_IN'; end if;
    select * into b from branches where id = v_last.branch_id;
  end if;
  if b.id is null or b.lat is null or b.lng is null then raise exception 'NO_BRANCH'; end if;
  if public.distance_m(p_lat, p_lng, b.lat, b.lng) > coalesce(b.radius, 100) then
    raise exception 'OUT_OF_RANGE';
  end if;

  if p_type = 'checkin' then
    select l.late_seconds, l.shift_start_min, l.permit_until, l.permit_comment into v_late, v_shift, v_pu, v_pc
      from public.lateness_with_permit(s.id, s.shifts, now()) l;
  end if;

  insert into attendance (staff_id, staff_name, branch_id, branch_name, type, time, late_minutes, late_seconds, no_shift,
                          permit_until, permit_comment, lat, lng)
  values (s.id, s.name, b.id, b.name, p_type, now(), coalesce(v_late, 0) / 60, coalesce(v_late, 0),
          p_type = 'checkin' and v_shift is null, v_pu, v_pc, p_lat, p_lng)
  returning * into rec;

  v_pen := public.apply_lateness(rec, s, v_shift);
  if rec.late_seconds > 0 then v_frz := public.check_freeze(s.id); end if;
  return jsonb_build_object('attendance', to_jsonb(rec), 'penalty', v_pen, 'freeze', v_frz);
end $$;

-- Admin qo'lda davomat qo'shishi: IZOH MAJBURIY. Kechikish, ruxsat va jarima xuddi shu qoida bilan.
drop function if exists public.admin_add_attendance(uuid, uuid, text, timestamptz);
create or replace function public.admin_add_attendance(p_staff_id uuid, p_branch_id uuid, p_type text, p_time timestamptz, p_comment text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare s staff; b branches; rec attendance; v_late int := 0; v_shift int; v_pen jsonb; v_frz jsonb; v_pu text; v_pc text; v_by text;
begin
  if not public.admin_can('attendance_edit') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_type not in ('checkin', 'checkout') then raise exception 'BAD_TYPE'; end if;
  p_comment := btrim(coalesce(p_comment, ''));
  if p_comment = '' then raise exception 'NEED_COMMENT'; end if;
  select * into s from staff where id = p_staff_id;
  if not found then raise exception 'NO_STAFF'; end if;
  select * into b from branches where id = p_branch_id;
  v_by := coalesce((select name from admins where user_id = auth.uid()),
                   (select name from staff where user_id = auth.uid()), 'Admin');
  if p_type = 'checkin' then
    select l.late_seconds, l.shift_start_min, l.permit_until, l.permit_comment into v_late, v_shift, v_pu, v_pc
      from public.lateness_with_permit(s.id, s.shifts, p_time) l;
  end if;
  insert into attendance (staff_id, staff_name, branch_id, branch_name, type, time, late_minutes, late_seconds, no_shift,
                          permit_until, permit_comment, manual, manual_comment, manual_by)
  values (s.id, s.name, b.id, b.name, p_type, p_time, coalesce(v_late, 0) / 60, coalesce(v_late, 0),
          p_type = 'checkin' and v_shift is null, v_pu, v_pc, true, left(p_comment, 500), v_by)
  returning * into rec;
  v_pen := public.apply_lateness(rec, s, v_shift);
  if rec.late_seconds > 0 then v_frz := public.check_freeze(s.id); end if;
  return jsonb_build_object('attendance', to_jsonb(rec), 'penalty', v_pen, 'freeze', v_frz);
end $$;

-- =============================================
-- KECHIKISHGA RUXSAT ("attendance_permit" ruxsati)
-- Xodimning ma'lum kundagi ish boshlanishi belgilangan vaqtga suriladi. Izoh majburiy.
-- Ruxsat xodim "Keldim" qilishidan OLDIN beriladi; kelgandan keyin — "Jarimani bekor qilish" ishlatiladi.
-- =============================================
create or replace function public.grant_permit(p_staff uuid, p_date date, p_until text, p_comment text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s staff; sh record; v_until time; v_until_min int; v_by text; v_id uuid; v_shift text; v_old int;
begin
  if not public.admin_can('attendance_permit') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  p_comment := btrim(coalesce(p_comment, ''));
  if p_comment = '' then raise exception 'NEED_COMMENT'; end if;
  if coalesce(p_until, '') !~ '^\d{1,2}:\d{2}$' then raise exception 'BAD_TIME'; end if;
  v_until := p_until::time;
  if p_date is null or p_date < (now() at time zone 'Asia/Tashkent')::date then raise exception 'PAST_DATE'; end if;
  select * into s from staff where id = p_staff;
  if not found then raise exception 'NO_STAFF'; end if;

  -- Ruxsat vaqti o'sha kungi smena oralig'ida bo'lishi kerak
  select * into sh from public.pick_shift(s.shifts, p_date + v_until);
  v_until_min := extract(hour from v_until)::int * 60 + extract(minute from v_until)::int;
  if not found then raise exception 'NO_SHIFT_DAY'; end if;
  if not (v_until_min > sh.start_min and v_until_min < sh.start_min + coalesce(sh.dur_min, 240)) then
    raise exception 'TIME_OUT_OF_SHIFT';
  end if;

  if exists (select 1 from attendance where staff_id = s.id and type = 'checkin' and not deleted
             and (time at time zone 'Asia/Tashkent')::date = p_date) then
    raise exception 'ALREADY_CHECKED_IN';
  end if;

  v_by := coalesce((select name from admins where user_id = auth.uid()),
                   (select name from staff where user_id = auth.uid()), 'Admin');
  -- Shu kunga oldingi ruxsat bo'lsa — yangisi bilan almashtiriladi
  update attendance_permits set cancelled = true, cancelled_by = v_by, cancelled_at = now()
   where staff_id = s.id and permit_date = p_date and not cancelled;
  get diagnostics v_old = row_count;

  insert into attendance_permits (staff_id, staff_name, permit_date, allowed_until, comment, created_by)
  values (s.id, s.name, p_date, v_until, left(p_comment, 500), v_by)
  returning id into v_id;

  v_shift := lpad((sh.start_min / 60)::text, 2, '0') || ':' || lpad((sh.start_min % 60)::text, 2, '0');
  insert into tasks (title, body, type, assigned_to, assigned_name, created_by, replies, done)
  values ('Kechikishga ruxsat: ' || to_char(p_date, 'DD.MM.YYYY') || ', ' || to_char(v_until, 'HH24:MI') || ' gacha',
          concat_ws(E'\n',
            'Kun: ' || to_char(p_date, 'DD.MM.YYYY'),
            'Ish boshlanishi ' || v_shift || ' → ' || to_char(v_until, 'HH24:MI') || ' ga surildi',
            'Shu vaqtgacha kelsangiz, kechikish va jarima hisoblanmaydi.',
            'Izoh: ' || left(p_comment, 500),
            'Ruxsat berdi: ' || v_by,
            case when v_old > 0 then 'Shu kunga avvalgi ruxsat almashtirildi.' end),
          'note', s.id, s.name, 'system', '[]'::jsonb, false);

  return jsonb_build_object('id', v_id, 'staff_name', s.name, 'date', p_date, 'until', to_char(v_until, 'HH24:MI'),
                            'shift_start', v_shift, 'replaced', v_old > 0);
end $$;

create or replace function public.cancel_permit(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pm attendance_permits; v_by text;
begin
  if not public.admin_can('attendance_permit') then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into pm from attendance_permits where id = p_id for update;
  if not found or pm.cancelled then raise exception 'NOT_FOUND'; end if;
  if exists (select 1 from attendance where staff_id = pm.staff_id and type = 'checkin' and not deleted
             and (time at time zone 'Asia/Tashkent')::date = pm.permit_date) then
    raise exception 'PERMIT_USED';
  end if;
  v_by := coalesce((select name from admins where user_id = auth.uid()),
                   (select name from staff where user_id = auth.uid()), 'Admin');
  update attendance_permits set cancelled = true, cancelled_by = v_by, cancelled_at = now() where id = pm.id;
  if pm.staff_id is not null then
    insert into tasks (title, body, type, assigned_to, assigned_name, created_by, replies, done)
    values ('Kechikishga ruxsat bekor qilindi: ' || to_char(pm.permit_date, 'DD.MM.YYYY'),
            'Kun: ' || to_char(pm.permit_date, 'DD.MM.YYYY') || E'\nIsh vaqtingiz odatdagidek.' || E'\nBekor qildi: ' || v_by,
            'note', pm.staff_id, pm.staff_name, 'system', '[]'::jsonb, false);
  end if;
end $$;

-- =============================================
-- VAZIFALAR: xodim faqat "bajarildi" va javob yoza oladi
-- =============================================
create or replace function public.can_see_task(p_task uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.admin_can_any(array['tasks_view', 'tasks_manage']) or exists (
    select 1 from tasks t
    where t.id = p_task
      and public.my_staff_id() is not null
      and (t.assigned_to is null or t.assigned_to = public.my_staff_id())
  )
$$;

create or replace function public.task_set_done(p_task uuid, p_done boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_see_task(p_task) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update tasks set done = coalesce(p_done, false) where id = p_task;
end $$;

create or replace function public.task_add_reply(p_task uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not public.can_see_task(p_task) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  p_text := btrim(coalesce(p_text, ''));
  if p_text = '' then return; end if;
  v_name := coalesce((select name from admins where user_id = auth.uid()),
                     (select name from staff where user_id = auth.uid()), '?');
  update tasks
     set replies = coalesce(replies, '[]'::jsonb)
                   || jsonb_build_array(jsonb_build_object('from', v_name, 'text', left(p_text, 2000), 'time', now()))
   where id = p_task;
end $$;

-- Funksiyalarni faqat tizimga kirganlar chaqira oladi
do $$
declare f text;
begin
  foreach f in array array[
    'app_role()', 'is_admin()', 'admin_can(text)', 'admin_can_any(text[])', 'my_staff_id()', 'whoami()',
    'update_my_name(text)', 'set_admin_permissions(uuid,jsonb)', 'set_staff_penalty(uuid,boolean)',
    'close_my_stale_session()', 'staff_check(text,float8,float8,uuid)',
    'admin_add_attendance(uuid,uuid,text,timestamptz,text)', 'can_see_task(uuid)',
    'grant_permit(uuid,date,text,text)', 'cancel_permit(uuid)', 'delete_attendance(uuid,text)',
    'task_set_done(uuid,boolean)', 'task_add_reply(uuid,text)',
    'unfreeze_staff(uuid)', 'set_freeze_limit(int)', 'staff_late_totals()', 'cancel_penalty(uuid,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- Ichki funksiya: faqat boshqa server funksiyalari chaqiradi
  revoke all on function public.apply_lateness(attendance, staff, int) from public, anon, authenticated;
  revoke all on function public.lateness_with_permit(uuid, jsonb, timestamptz) from public, anon, authenticated;
  revoke all on function public.do_cancel_penalty(uuid, text) from public, anon, authenticated;
  revoke all on function public.check_freeze(uuid) from public, anon, authenticated;
end $$;

-- =============================================
-- RLS — ruxsatlarga asoslangan
-- =============================================
alter table branches         enable row level security;
alter table staff            enable row level security;
alter table admins           enable row level security;
alter table attendance       enable row level security;
alter table tasks            enable row level security;
alter table app_tags         enable row level security;
alter table penalty_settings enable row level security;
alter table penalties        enable row level security;
alter table attendance_permits enable row level security;

-- Oldingi siyosatlarni tozalash
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('branches','staff','admins','attendance','tasks','app_tags','penalty_settings','penalties','attendance_permits')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- Filiallar: tizimdagi har kim o'qiydi (GPS uchun); "branches" ruxsati bilan yoziladi
create policy branches_read  on branches for select to authenticated using (public.app_role() is not null);
create policy branches_write on branches for all    to authenticated
  using (public.admin_can('branches')) with check (public.admin_can('branches'));

-- Xodimlar: admin hammasini, xodim faqat o'zini. Yozish — faqat Edge Function / RPC
create policy staff_read  on staff  for select to authenticated using (public.is_admin() or user_id = auth.uid());
-- Adminlar: superadmin hammasini, admin o'zini. Yozish — faqat Edge Function / RPC
create policy admins_read on admins for select to authenticated using (public.app_role() = 'superadmin' or user_id = auth.uid());

-- Davomat: ruxsati bor admin yoki xodimning o'zi. Yozish — faqat RPC
-- O'chirilgan yozuvlar hech kimga ko'rinmaydi (bazada tarix sifatida qoladi)
create policy attendance_read on attendance for select to authenticated
  using (not deleted
         and (public.admin_can_any(array['attendance', 'attendance_edit', 'attendance_delete', 'reports', 'dashboard', 'dashboard_late', 'dashboard_absent'])
              or staff_id = public.my_staff_id()));

-- Vazifalar: xodim o'ziga va "barcha xodimlar"ga berilganini; admin "tasks_view"/"tasks_manage" bilan
create policy tasks_read  on tasks for select to authenticated
  using (public.admin_can_any(array['tasks_view', 'tasks_manage'])
         or (public.my_staff_id() is not null and (assigned_to is null or assigned_to = public.my_staff_id())));
create policy tasks_write on tasks for all to authenticated
  using (public.admin_can('tasks_manage')) with check (public.admin_can('tasks_manage'));

-- Teglar: tizimdagi har kim o'qiydi, superadmin yozadi
create policy tags_read  on app_tags for select to authenticated using (public.app_role() is not null);
create policy tags_write on app_tags for all    to authenticated
  using (public.app_role() = 'superadmin') with check (public.app_role() = 'superadmin');

-- Jarima sozlamalari: tizimdagi har kim o'qiydi, "penalty_settings" ruxsati bilan o'zgartiriladi
create policy penset_read   on penalty_settings for select to authenticated using (public.app_role() is not null);
create policy penset_update on penalty_settings for update to authenticated
  using (public.admin_can('penalty_settings')) with check (public.admin_can('penalty_settings'));

-- Jarima / intizom tarixi: "dashboard_penalties" ruxsati bor admin yoki xodimning o'zi. Yozish — faqat server
-- Ruxsatlar: ruxsati bor admin yoki xodimning o'zi. Yozish — faqat RPC (grant_permit / cancel_permit)
create policy permits_read on attendance_permits for select to authenticated
  using (public.admin_can_any(array['attendance_permit', 'attendance', 'attendance_edit', 'reports'])
         or staff_id = public.my_staff_id());

create policy penalties_read on penalties for select to authenticated
  using (public.admin_can_any(array['dashboard_penalties', 'penalty_cancel']) or staff_id = public.my_staff_id());

-- Parol ustunlarini klientga umuman bermaslik (finalize'gacha bo'lgan oraliq uchun ham)
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='staff' and column_name='password') then
    revoke select on staff from anon, authenticated;
    grant select (id, name, login, role, position, branch_id, branch_name, shifts, permissions, created_at, user_id, penalty_enabled,
                  frozen, frozen_at, frozen_late_seconds, frozen_limit_minutes, late_counter_from) on staff to authenticated;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='admins' and column_name='password') then
    revoke select on admins from anon, authenticated;
    grant select (id, name, login, permissions, created_at, user_id, is_super) on admins to authenticated;
  end if;
end $$;

-- =============================================
-- REALTIME: yangi vazifa va bildirishnomalar darhol kelsin (RLS hisobga olinadi)
-- =============================================
do $$ begin
  alter publication supabase_realtime add table tasks;
exception when duplicate_object then null;
          when undefined_object then null;
end $$;

-- =============================================
-- BOSHLANG'ICH TEGLAR (faqat bo'sh bo'lsa)
-- =============================================
insert into app_tags (kind, label, sort)
select * from (values
  ('late','Tirbandlik',1), ('late','Transport kechikdi',2), ('late','Oilaviy sabab',3),
  ('late','Salomatlik',4), ('late','Boshqa',9)
) as v(kind, label, sort)
where not exists (select 1 from app_tags);

-- =============================================
-- API keshini yangilash: yangi/o'zgargan funksiyalar darhol ko'rinsin
-- ("Could not find the function ... in the schema cache" xatosining oldini oladi)
-- =============================================
notify pgrst, 'reload schema';
