create extension if not exists "pgcrypto";

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[0-9]{6}$'),
  status text not null check (status in ('waiting', 'preparing', 'playing', 'finished')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  telegram_id bigint,
  name text not null,
  color text not null,
  status text not null check (status in ('connected', 'disconnected', 'bot')),
  socket_id text,
  joined_at timestamptz not null default now(),
  disconnected_at timestamptz,
  bot_replacement_for uuid references public.players(id)
);

create table if not exists public.game_states (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.game_states;
