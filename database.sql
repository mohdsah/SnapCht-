create table public.videos (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  avatar text default '👤',
  username text not null,
  description text,
  music text default 'original sound',
  video_url text not null,
  likes integer default 0,
  comments text default '0'
);

-- Buka akses Read & Write kepada pengguna Anon (RLS)
alter table public.videos enable row level security;
create policy "Allow public read" on public.videos for select using (true);
create policy "Allow public insert" on public.videos for insert with check (true);
