-- 이메일 알림(Gmail SMTP) 구독 정보. 로그인은 Firebase 이므로 uid 는 Firebase uid(문자열)다.
-- ⚠️ 이메일 주소는 개인정보라서 RLS 를 켜고 정책을 하나도 만들지 않는다 → anon/로그인 사용자는 이 테이블을 직접 읽거나 쓸 수 없고,
--    Edge Function(mail-notify)만 service_role 로 접근한다.

create table if not exists public.email_subscriptions (
    uid                 text primary key,
    email               text not null,
    verified            boolean not null default false,
    code_hash           text,
    code_expires_at     timestamptz,
    code_requested_at   timestamptz,
    code_attempts       integer not null default 0,
    notify_comments     boolean not null default true,
    notify_notices      boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
alter table public.email_subscriptions enable row level security;

-- 같은 Gmail 주소를 인증한 계정은 하나만(남의 주소로 알림을 보내는 오용 방지)
create unique index if not exists email_subscriptions_verified_email_uq
    on public.email_subscriptions (lower(email)) where verified;

-- 발송/호출 기록: 하루 발송 한도 확인, 같은 알림 중복 방지, 호출 횟수 제한에 쓴다.
create table if not exists public.email_log (
    id          bigserial primary key,
    created_at  timestamptz not null default now(),
    uid         text not null,          -- 받는 사람(또는 호출한 사람, kind='call')
    kind        text not null,          -- code | comment | notice | call
    key         text                    -- 중복 방지 키(예: c:<댓글ID>, notice:<공지ID>)
);
alter table public.email_log enable row level security;
create index if not exists email_log_created_idx on public.email_log (created_at);
create index if not exists email_log_key_idx on public.email_log (key) where key is not null;
create index if not exists email_log_uid_kind_idx on public.email_log (uid, kind, created_at);
