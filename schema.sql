-- =====================================================
-- KANBAN · Схема БД для Supabase
-- =====================================================
-- Запусти этот скрипт целиком в SQL Editor проекта Supabase.
-- (Sidebar → SQL Editor → New query → вставить → Run)
-- =====================================================

-- 1. Таблица пользователей -----------------------------
create table if not exists public.users (
  id          text primary key,
  login       text unique not null,
  password    text not null,
  name        text not null,
  color       text not null default '#7c5cff'
);

-- 2. Таблица категорий ---------------------------------
create table if not exists public.categories (
  id          text primary key,
  name        text not null,
  color       text not null default '#7c5cff'
);

-- 3. Таблица задач (активные) --------------------------
create table if not exists public.tasks (
  id              text primary key,
  title           text not null,
  description     text default '',
  status          text not null check (status in ('todo','analysis','in_progress','review','done')),
  priority        text not null default 'medium' check (priority in ('low','medium','high')),
  category_id     text references public.categories(id) on delete set null,
  assignee_id     text references public.users(id) on delete set null,
  deadline        date,
  repeat_monthly  boolean not null default false,
  created_at      timestamptz not null default now()
);

-- 4. Архив выполненных задач ---------------------------
create table if not exists public.archive (
  id              text primary key,
  title           text not null,
  description     text default '',
  status          text not null default 'done',
  priority        text not null default 'medium',
  category_id     text,
  assignee_id     text,
  deadline        date,
  repeat_monthly  boolean not null default false,
  created_at      timestamptz,
  archived_at     timestamptz not null default now()
);

-- 5. Метаданные (один ряд для служебных полей) ---------
create table if not exists public.meta (
  id                   integer primary key default 1,
  last_monthly_check   date not null default current_date,
  constraint meta_one_row check (id = 1)
);

-- =====================================================
-- ВКЛЮЧАЕМ REALTIME ДЛЯ ВСЕХ ТАБЛИЦ
-- =====================================================
alter publication supabase_realtime add table public.users;
alter publication supabase_realtime add table public.categories;
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.archive;
alter publication supabase_realtime add table public.meta;

-- =====================================================
-- РАЗРЕШАЕМ ДОСТУП АНОНИМНОМУ КЛИЕНТУ
-- =====================================================
-- Для нашего приложения мы используем собственную авторизацию
-- через таблицу users, поэтому RLS оставляем выключенным
-- (в продакшене лучше включить RLS и настроить политики).

alter table public.users      disable row level security;
alter table public.categories disable row level security;
alter table public.tasks      disable row level security;
alter table public.archive    disable row level security;
alter table public.meta       disable row level security;

-- =====================================================
-- НАЧАЛЬНЫЕ ДАННЫЕ
-- =====================================================

-- Пользователи (логины и пароли — поменяй на свои)
insert into public.users (id, login, password, name, color) values
  ('u1', 'admin', 'admin123', 'Алексей', '#7c5cff'),
  ('u2', 'user',  'user123',  'Мария',   '#ff6b9d')
on conflict (id) do nothing;

-- Категории по умолчанию
insert into public.categories (id, name, color) values
  ('c1', 'Работа', '#3b82f6'),
  ('c2', 'Дом',    '#10b981'),
  ('c3', 'Учёба',  '#f59e0b'),
  ('c4', 'Личное', '#ef4444')
on conflict (id) do nothing;

-- Демо-задачи
insert into public.tasks (id, title, description, status, priority, category_id, assignee_id, deadline, repeat_monthly) values
  ('t1', 'Оплатить коммунальные услуги', 'ЖКХ, интернет, электричество', 'todo',        'high',   'c2', null, null, true),
  ('t2', 'Подготовить отчёт за месяц',   'Свести цифры и отправить',     'analysis',    'high',   'c1', 'u1', '2026-05-05', true),
  ('t3', 'Закупка продуктов',            'На неделю вперёд',             'in_progress', 'medium', 'c2', 'u2', null, false),
  ('t4', 'Прочитать главу учебника',     'Глава 5 + конспект',           'review',      'low',    'c3', 'u2', '2026-05-10', false),
  ('t5', 'Сходить в зал',                'Ноги + спина',                 'done',        'low',    'c4', 'u1', null, false)
on conflict (id) do nothing;

-- Метастрока
insert into public.meta (id, last_monthly_check)
values (1, current_date)
on conflict (id) do nothing;

-- =====================================================
-- Готово! Возвращайся в приложение и впиши URL и anon key
-- из Settings → API в файл script.js (константы SUPABASE_URL и SUPABASE_KEY)
-- =====================================================
