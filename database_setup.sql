-- Run this AFTER the initial tables and storage bucket have been created.
-- This script replaces self-referencing RLS checks with a SECURITY DEFINER helper,
-- adds a secure RPC for creating one-to-one conversations, and enables realtime.

-- A SECURITY DEFINER helper avoids recursive RLS checks on conversation_participants.
create or replace function public.is_conversation_participant(target_conversation_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_participants cp
    where cp.conversation_id = target_conversation_id
      and cp.user_id = target_user_id
  );
$$;

revoke all on function public.is_conversation_participant(uuid, uuid) from public;
grant execute on function public.is_conversation_participant(uuid, uuid) to authenticated;

-- Replace policies that query the participants table directly.
drop policy if exists "Participants can view conversations" on public.conversations;
create policy "Participants can view conversations"
on public.conversations for select to authenticated
using (public.is_conversation_participant(id, auth.uid()));

drop policy if exists "Participants can view participants" on public.conversation_participants;
drop policy if exists "Users can view participants in their conversations" on public.conversation_participants;
create policy "Users can view participants in their conversations"
on public.conversation_participants for select to authenticated
using (public.is_conversation_participant(conversation_id, auth.uid()));

drop policy if exists "Participants can read messages" on public.messages;
create policy "Participants can read messages"
on public.messages for select to authenticated
using (public.is_conversation_participant(conversation_id, auth.uid()));

drop policy if exists "Participants can send messages" on public.messages;
create policy "Participants can send messages"
on public.messages for insert to authenticated
with check (
  sender_id = auth.uid()
  and public.is_conversation_participant(conversation_id, auth.uid())
);

-- Replace Storage policies so private file access checks membership safely.
drop policy if exists "Participants can upload chat files" on storage.objects;
create policy "Participants can upload chat files"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'chat-attachments'
  and public.is_conversation_participant(
    (storage.foldername(name))[1]::uuid, auth.uid()
  )
);

drop policy if exists "Participants can download chat files" on storage.objects;
create policy "Participants can download chat files"
on storage.objects for select to authenticated
using (
  bucket_id = 'chat-attachments'
  and public.is_conversation_participant(
    (storage.foldername(name))[1]::uuid, auth.uid()
  )
);

-- The client uses this RPC instead of inserting participant rows directly.
create or replace function public.create_private_conversation(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_conversation_id uuid;
  my_id uuid := auth.uid();
begin
  if my_id is null then
    raise exception 'You must be logged in';
  end if;
  if other_user_id is null or other_user_id = my_id then
    raise exception 'Choose another user';
  end if;
  if not exists (select 1 from public.profiles where id = other_user_id) then
    raise exception 'User not found';
  end if;

  select cp1.conversation_id into new_conversation_id
  from public.conversation_participants cp1
  join public.conversation_participants cp2
    on cp1.conversation_id = cp2.conversation_id
  where cp1.user_id = my_id and cp2.user_id = other_user_id
  group by cp1.conversation_id
  having count(*) = 2
  limit 1;

  if new_conversation_id is not null then
    return new_conversation_id;
  end if;

  insert into public.conversations default values returning id into new_conversation_id;
  insert into public.conversation_participants (conversation_id, user_id)
  values (new_conversation_id, my_id), (new_conversation_id, other_user_id);

  return new_conversation_id;
end;
$$;

revoke all on function public.create_private_conversation(uuid) from public;
grant execute on function public.create_private_conversation(uuid) to authenticated;

-- Do not create direct client INSERT policies for conversation_participants.
-- The SECURITY DEFINER RPC above inserts both participants.
-- Messages remain without update/delete policies by default.

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then
  null;
end $$;
