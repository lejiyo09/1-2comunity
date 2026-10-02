-- ============================================================================
-- 앱스토어(웹앱 게시) 기능용 DB / Storage 설정
--
-- 적용 위치: Supabase 대시보드 → SQL Editor, 프로젝트 "자료실용"(cryeosgmuxqyphntqqlc)에서 이 파일 전체를 한 번 실행한다.
-- 기존 테이블(materials 등)은 전혀 건드리지 않고, 새 테이블/함수/버킷만 추가한다. 여러 번 실행해도 안전하다(idempotent).
--
-- ⚠️ 이 사이트의 로그인은 Supabase Auth가 아니라 Firebase Auth다. 그래서 Supabase의 auth.uid() 기반 RLS로는 "누가 만든 앱인지"를
--    판별할 수 없다. 기존 자료실/음악 기능과 같은 방식으로 처리한다:
--      - 읽기: RLS로 "공개(published) 앱"만 누구나(anon) 조회 가능
--      - 쓰기(등록/수정/삭제): anon/authenticated 에게는 INSERT/UPDATE/DELETE 권한 자체를 주지 않고(아래 REVOKE + 정책 없음),
--        Edge Function `apps-write`가 Firebase ID 토큰을 검증하고 "작성자 본인인지" 확인한 뒤 service_role 키로만 쓴다.
-- ============================================================================

-- 1) 앱 테이블 -----------------------------------------------------------------
create table if not exists public.apps (
    id            text primary key check (id ~ '^[a-z0-9]{6,12}$'),   -- 공개 주소 /app/<id> 에 쓰이는 고유 ID (수정해도 바뀌지 않음)
    author_uid    text not null,                                       -- 작성자 Firebase UID (소유권 판단 기준)
    author_name   text not null default '',                            -- 화면에 보여줄 제작자 이름(등록 시점 닉네임)
    name          text not null check (char_length(name) between 1 and 40),
    description   text not null default '' check (char_length(description) <= 1000),
    icon_url      text,                                                -- 공개 URL (없으면 화면에서 기본 아이콘을 그린다)
    icon_path     text,                                                -- Storage 내부 경로 (아이콘 교체/삭제 시 정리용)
    category      text not null default '기타',
    version       text not null default '1.0.0' check (char_length(version) between 1 and 20),
    file_path     text not null,                                       -- 현재 버전의 Storage 경로 (webapps 버킷)
    file_type     text not null check (file_type in ('html', 'zip')),
    entry_file    text not null default 'index.html',                  -- ZIP일 때 진입점(항상 index.html)
    file_size     bigint not null default 0,
    published     boolean not null default true,
    featured      boolean not null default false,                      -- "추천 앱" 노출용 (운영자가 SQL로 직접 true로 바꿈)
    views         bigint not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index if not exists apps_published_created_idx on public.apps (published, created_at desc);
create index if not exists apps_published_views_idx   on public.apps (published, views desc);
create index if not exists apps_author_idx            on public.apps (author_uid);

-- 2) 버전 이력 테이블 ------------------------------------------------------------
create table if not exists public.app_versions (
    id          uuid primary key default gen_random_uuid(),
    app_id      text not null references public.apps(id) on delete cascade,
    version     text not null,
    file_path   text not null,
    file_type   text not null check (file_type in ('html', 'zip')),
    file_size   bigint not null default 0,
    changelog   text not null default '' check (char_length(changelog) <= 1000),
    created_at  timestamptz not null default now()
);
create index if not exists app_versions_app_idx on public.app_versions (app_id, created_at desc);

-- 3) RLS: 읽기만 공개, 쓰기는 정책 자체가 없다(= 클라이언트의 직접 쓰기 전부 거부) -------------
alter table public.apps         enable row level security;
alter table public.app_versions enable row level security;

drop policy if exists apps_public_read on public.apps;
create policy apps_public_read on public.apps
    for select to anon, authenticated
    using (published = true);

drop policy if exists app_versions_public_read on public.app_versions;
create policy app_versions_public_read on public.app_versions
    for select to anon, authenticated
    using (exists (select 1 from public.apps a where a.id = app_versions.app_id and a.published = true));

-- 방어선 한 겹 더: 정책이 없어도 거부되지만, 권한 자체도 회수해 둔다(service_role은 영향 없음).
revoke insert, update, delete, truncate on public.apps         from anon, authenticated;
revoke insert, update, delete, truncate on public.app_versions from anon, authenticated;

-- 4) 조회수 증가 RPC (조회수 컬럼만 +1, 공개 앱에만) ------------------------------------
create or replace function public.increment_app_views(p_app_id text)
returns void
language sql
security definer
set search_path = public
as $$
    update public.apps set views = views + 1 where id = p_app_id and published = true;
$$;
revoke all on function public.increment_app_views(text) from public;
grant execute on function public.increment_app_views(text) to anon, authenticated;

-- 5) Storage 버킷 ---------------------------------------------------------------
-- 공개 버킷: 앱 실행/다운로드가 로그인 없이도 되어야 하므로 읽기는 공개다. 쓰기(업로드)는 Edge Function이 발급한
-- "서명된 업로드 URL"로만 가능하다(anon에게 storage.objects INSERT 정책을 주지 않는다).
-- 파일 크기 20MB 제한, 허용 형식은 HTML/ZIP/이미지(아이콘)만. (SVG 아이콘은 스크립트를 담을 수 있어 허용하지 않는다.)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'webapps', 'webapps', true, 20971520,
    array['text/html', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream',
          'image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

-- (참고) storage.objects 에는 webapps 버킷에 대한 INSERT/UPDATE/DELETE 정책을 만들지 않는다 → 클라이언트 직접 업로드/덮어쓰기/삭제 불가.
-- SELECT 는 공개 버킷이라 별도 정책 없이 공개 URL 로 읽힌다.
