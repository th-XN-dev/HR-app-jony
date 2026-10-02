-- =============================================
-- JONY KIDS — FINAL QADAM (scripts/migrate-users.mjs muvaffaqiyatli tugagandan KEYIN)
-- Ochiq matndagi parollarni butunlay o'chiradi. Qaytarib bo'lmaydi!
-- =============================================

-- Tekshiruv: Auth'ga bog'lanmagan foydalanuvchi qolmaganmi?
do $$ begin
  if exists (select 1 from staff where user_id is null) or exists (select 1 from admins where user_id is null) then
    raise exception 'Hali Auth''ga bog''lanmagan foydalanuvchilar bor. Avval scripts/migrate-users.mjs ni ishga tushiring.';
  end if;
end $$;

alter table staff  drop column if exists password;
alter table admins drop column if exists password;

-- Ustun cheklovi endi kerak emas — oddiy select huquqini qaytaramiz (RLS baribir ishlaydi)
grant select on staff  to authenticated;
grant select on admins to authenticated;
