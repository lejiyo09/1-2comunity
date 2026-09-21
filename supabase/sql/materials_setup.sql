-- 자료실(Materials) 백엔드 설정.
-- Supabase 대시보드의 SQL Editor에서 이 파일 전체를 한 번 실행하면 된다.
-- (이전 자료실용 Supabase 프로젝트가 사라지면서 이 설정 자체가 통째로 유실됐던 적이 있어서,
--  다시는 그런 일이 없도록 이번엔 저장소에 SQL로 남겨둔다.)

create extension if not exists pgcrypto; -- gen_random_uuid() 사용을 위해 필요

create table if not exists public.materials (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    category text not null default '기타',
    description text,
    owner_uid text not null,           -- Firebase UID (Supabase auth와는 무관 - Edge Function이 직접 검증)
    owner_name text,
    original_file_name text,
    file_size bigint,
    storage_path text,                 -- materials 버킷 안의 경로. 첨부파일 없는 글이면 null.
    download_count integer not null default 0,
    status text not null default 'active', -- 'active' | 'deleted' (지금은 하드 삭제라 실제로는 항상 active만 남음)
    created_at timestamptz not null default now()
);

create index if not exists materials_status_created_at_idx
    on public.materials (status, created_at desc);

alter table public.materials enable row level security;

-- 삭제 후 재실행해도 안전하도록, 있으면 지우고 다시 만든다.
drop policy if exists materials_public_read on public.materials;
create policy materials_public_read
    on public.materials
    for select
    using (status = 'active');

-- insert/update/delete는 별도 정책을 만들지 않는다 - RLS가 기본적으로 모두 거부하므로,
-- anon(publishable) 키로는 절대 쓸 수 없다. 실제 쓰기는 Edge Function이 service_role로만 수행한다.

-- 다운로드 수를 안전하게(동시 다운로드에도 유실 없이) 1 증가시키는 함수.
create or replace function public.increment_download_count(material_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
    update public.materials set download_count = download_count + 1 where id = material_id;
$$;

grant execute on function public.increment_download_count(uuid) to anon, authenticated;

-- Storage 버킷: materials (비공개 - 서명된 URL로만 접근)
insert into storage.buckets (id, name, public)
values ('materials', 'materials', false)
on conflict (id) do nothing;

-- 클라이언트(anon 키)가 서명 URL을 발급받으려면 storage.objects에 대한 select 정책이 있어야 한다.
-- materials 테이블 자체가 이미 누구나 읽을 수 있게 열려 있으므로(위 materials_public_read),
-- 같은 공개 범위로 버킷도 열어준다. 업로드/삭제는 여전히 Edge Function(service_role)만 가능하다
-- (아래에 insert/update/delete 정책을 만들지 않았으므로 RLS가 기본 거부한다).
drop policy if exists materials_bucket_public_read on storage.objects;
create policy materials_bucket_public_read
    on storage.objects
    for select
    using (bucket_id = 'materials');
