-- =============================================
-- JONY KIDS EduPanel — Supabase SQL Setup
-- Ushbu SQL ni Supabase SQL Editor'da ishga tushiring
-- =============================================

-- 1. STUDENTS (Talabalar)
create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  teacher text,
  group_name text,
  status text default 'trial', -- trial | contract | frozen | left
  freeze_reason text,
  return_date date,
  created_at timestamptz default now()
);

-- 2. TEACHERS (O'qituvchilar)
create table if not exists teachers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text default '#5ee7d3',
  created_at timestamptz default now()
);

-- 3. GROUPS (Guruhlar)
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text default '#7c9bff',
  created_at timestamptz default now()
);

-- 4. BRANCHES (Filiallar)
create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  lat double precision,        -- GPS kenglik
  lng double precision,        -- GPS uzunlik
  radius integer default 100,  -- ruxsat etilgan radius (metr)
  created_at timestamptz default now()
);

-- 5. STAFF (Xodimlar)
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  login text unique not null,
  password text not null,
  role text default 'staff', -- staff | admin
  position text,
  branch_id uuid references branches(id),
  branch_name text,
  shifts jsonb default '[]', -- [{"start":"08:00","end":"17:00"}]
  permissions jsonb default '{}',
  created_at timestamptz default now()
);

-- 6. ADMINS (Adminlar)
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  login text unique not null,
  password text not null,
  permissions jsonb default '{"add_staff":true,"tasks":true,"reports":true,"students":true}',
  created_at timestamptz default now()
);

-- 7. ATTENDANCE (Davomat)
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id) on delete cascade,
  staff_name text,
  branch_id uuid references branches(id),
  branch_name text,
  type text not null, -- checkin | checkout
  time timestamptz not null default now(),
  late_minutes integer default 0,
  lat double precision,   -- belgilangan paytdagi GPS kenglik
  lng double precision,   -- belgilangan paytdagi GPS uzunlik
  created_at timestamptz default now()
);

-- 8. TASKS (Vazifalar)
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  type text default 'task', -- task | note | alert
  assigned_to uuid references staff(id),
  assigned_name text,
  deadline timestamptz,
  created_by text,
  replies jsonb default '[]', -- [{from, text, time}]
  created_at timestamptz default now()
);

-- =============================================
-- RLS (Row Level Security) — Allow All
-- =============================================
alter table students enable row level security;
alter table teachers enable row level security;
alter table groups enable row level security;
alter table branches enable row level security;
alter table staff enable row level security;
alter table admins enable row level security;
alter table attendance enable row level security;
alter table tasks enable row level security;

-- Allow all policies (sozlash uchun)
-- Avval mavjud bo'lsa o'chiramiz (qayta ishga tushirishda xato bermasligi uchun)
drop policy if exists "allow all" on students;
drop policy if exists "allow all" on teachers;
drop policy if exists "allow all" on groups;
drop policy if exists "allow all" on branches;
drop policy if exists "allow all" on staff;
drop policy if exists "allow all" on admins;
drop policy if exists "allow all" on attendance;
drop policy if exists "allow all" on tasks;

create policy "allow all" on students for all using (true) with check (true);
create policy "allow all" on teachers for all using (true) with check (true);
create policy "allow all" on groups for all using (true) with check (true);
create policy "allow all" on branches for all using (true) with check (true);
create policy "allow all" on staff for all using (true) with check (true);
create policy "allow all" on admins for all using (true) with check (true);
create policy "allow all" on attendance for all using (true) with check (true);
create policy "allow all" on tasks for all using (true) with check (true);

-- =============================================
-- MIGRATION (agar jadvallar avval yaratilgan bo'lsa, shu qatorlarni ham ishga tushiring)
-- =============================================
alter table branches add column if not exists lat double precision;
alter table branches add column if not exists lng double precision;
alter table branches add column if not exists radius integer default 100;
alter table attendance add column if not exists lat double precision;
alter table attendance add column if not exists lng double precision;
-- Kechikish sababi va izoh
alter table attendance add column if not exists late_reason text;
alter table attendance add column if not exists late_comment text;
-- Talaba qaytish sanasi/holati uchun (freeze_reason allaqachon mavjud)
alter table students add column if not exists status_reason text;

-- =============================================
-- APP_TAGS (Holat sabablari + Kechikish sabablari teglari)
-- kind: 'late' (kechikish), 'trial'|'contract'|'frozen'|'left'|'returned' (talaba holati sababi)
-- =============================================
create table if not exists app_tags (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  label text not null,
  sort integer default 0,
  created_at timestamptz default now()
);
alter table app_tags enable row level security;
drop policy if exists "allow all" on app_tags;
create policy "allow all" on app_tags for all using (true) with check (true);

-- Boshlang'ich teglar (faqat bo'sh bo'lsa)
insert into app_tags (kind, label, sort)
select * from (values
  ('late','Tirbandlik',1),
  ('late','Transport kechikdi',2),
  ('late','Oilaviy sabab',3),
  ('late','Salomatlik',4),
  ('late','Boshqa',9),
  ('frozen','Kasallik',1),
  ('frozen','Safar',2),
  ('frozen','Moliyaviy',3),
  ('frozen','Ta''til',4),
  ('left','Ko''chib ketdi',1),
  ('left','Narx',2),
  ('left','Natijadan norozi',3),
  ('left','Boshqa markaz',4),
  ('returned','Qayta yozildi',1),
  ('returned','Muzlatishdan qaytdi',2),
  ('trial','Reklama orqali',1),
  ('trial','Tavsiya',2),
  ('contract','Sinovdan keyin',1)
) as v(kind,label,sort)
where not exists (select 1 from app_tags);

-- =============================================
-- DEMO DATA (Ixtiyoriy — test uchun)
-- Faqat jadval bo'sh bo'lsa qo'shiladi (qayta ishga tushirsa dublikat bo'lmaydi)
-- =============================================

-- Demo filial (koordinatalarni o'zingizning real filialingiznikiga almashtiring!)
insert into branches (name, address, lat, lng, radius)
select 'Chilonzor filiali', 'Chilonzor, 5-kvartal', 41.285000, 69.204000, 100
where not exists (select 1 from branches);
insert into branches (name, address, lat, lng, radius)
select 'Yunusobod filiali', 'Yunusobod, 19-kvartal', 41.367000, 69.289000, 100
where not exists (select 1 from branches where name = 'Yunusobod filiali');

-- Demo o'qituvchilar
insert into teachers (name, color)
select 'Sarvar Karimov', '#5ee7d3' where not exists (select 1 from teachers where name = 'Sarvar Karimov');
insert into teachers (name, color)
select 'Dilnoza Yusupova', '#7c9bff' where not exists (select 1 from teachers where name = 'Dilnoza Yusupova');

-- Demo guruhlar
insert into groups (name, color)
select 'Junior A', '#5ee7d3' where not exists (select 1 from groups where name = 'Junior A');
insert into groups (name, color)
select 'Middle B', '#7c9bff' where not exists (select 1 from groups where name = 'Middle B');
insert into groups (name, color)
select 'Senior C', '#f5b455' where not exists (select 1 from groups where name = 'Senior C');

-- Demo xodim (login: xodim1, parol: 1234)
insert into staff (name, login, password, role, position)
select 'Akbar Toshmatov', 'xodim1', '1234', 'staff', 'Administrator'
where not exists (select 1 from staff where login = 'xodim1');

-- Super admin alohida (hardcoded in code): login: superadmin, parol: super123
