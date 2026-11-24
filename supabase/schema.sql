-- InvoiceFlow PostgreSQL Schema & Row Level Security (Supabase)
-- Run this in your Supabase SQL Editor

create extension if not exists "pgcrypto";

-- 1. Organizations table
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  contact_email text,
  default_currency text not null default 'ZAR',
  created_at timestamptz not null default now()
);

create index if not exists idx_organizations_owner_id on public.organizations(owner_id);

-- 2. Clients table
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  company text,
  email text not null,
  phone text,
  reliability_label text not null default 'On-Time'
    check (reliability_label in ('On-Time', 'Slow Payer', 'At Risk')),
  created_at timestamptz not null default now()
);

create index if not exists idx_clients_org_id on public.clients(organization_id);
create index if not exists idx_clients_email on public.clients(organization_id, email);

-- 3. Invoices table
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  invoice_number text not null,
  description text not null,
  line_items jsonb not null default '[]'::jsonb,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'ZAR',
  status text not null default 'sent'
    check (status in ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  issue_date date not null default current_date,
  due_date date not null,
  paid_at timestamptz,
  paystack_reference text,
  promised_pay_date date,
  dispute_note text,
  last_reminded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_invoices_org_id on public.invoices(organization_id);
create index if not exists idx_invoices_client_id on public.invoices(client_id);
create index if not exists idx_invoices_status_due on public.invoices(status, due_date);
create unique index if not exists idx_invoices_org_number on public.invoices(organization_id, invoice_number);

-- 4. Reminder Logs table
create table if not exists public.reminder_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  channel text not null default 'email' check (channel in ('email', 'whatsapp')),
  template_tier text not null check (
    template_tier in ('upcoming', 'due_today', 'overdue_friendly', 'overdue_firm', 'manual')
  ),
  recipient text not null,
  subject text,
  provider_message_id text,
  status text not null default 'sent',
  sent_at timestamptz not null default now()
);

create index if not exists idx_reminder_logs_org_id on public.reminder_logs(organization_id);
create index if not exists idx_reminder_logs_invoice_id on public.reminder_logs(invoice_id);

-- 5. Historical Payment Reliability Calculation Function & Trigger
create or replace function public.recalculate_client_reliability(p_client_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_severe_count integer := 0;
  v_late_count integer := 0;
  v_next_label text := 'On-Time';
begin
  select
    count(*) filter (
      where (status in ('sent', 'overdue') and due_date < (current_date - interval '14 days'))
         or (status = 'paid' and paid_at::date > (due_date + interval '14 days'))
    ),
    count(*) filter (
      where (status in ('sent', 'overdue') and due_date < current_date)
         or (status = 'paid' and paid_at::date > due_date)
    )
  into v_severe_count, v_late_count
  from public.invoices
  where client_id = p_client_id
    and status <> 'cancelled'
    and status <> 'draft';

  if v_severe_count >= 1 or v_late_count >= 2 then
    v_next_label := 'At Risk';
  elsif v_late_count = 1 then
    v_next_label := 'Slow Payer';
  else
    v_next_label := 'On-Time';
  end if;

  update public.clients
  set reliability_label = v_next_label
  where id = p_client_id;
end;
$$;

create or replace function public.trg_sync_client_reliability()
returns trigger
language plpgsql
security definer
as $$
begin
  perform public.recalculate_client_reliability(coalesce(new.client_id, old.client_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_invoices_reliability on public.invoices;
create trigger trg_invoices_reliability
after insert or update of status, due_date, paid_at on public.invoices
for each row
execute function public.trg_sync_client_reliability();

-- 6. Row Level Security (RLS)
alter table public.organizations enable row level security;
alter table public.clients enable row level security;
alter table public.invoices enable row level security;
alter table public.reminder_logs enable row level security;

-- Organizations policies
drop policy if exists "Organizations: owners can select" on public.organizations;
create policy "Organizations: owners can select"
  on public.organizations for select
  using (owner_id = auth.uid());

drop policy if exists "Organizations: owners can insert" on public.organizations;
create policy "Organizations: owners can insert"
  on public.organizations for insert
  with check (owner_id = auth.uid());

drop policy if exists "Organizations: owners can update" on public.organizations;
create policy "Organizations: owners can update"
  on public.organizations for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "Organizations: owners can delete" on public.organizations;
create policy "Organizations: owners can delete"
  on public.organizations for delete
  using (owner_id = auth.uid());

-- Clients policies
drop policy if exists "Clients: org owners full access" on public.clients;
create policy "Clients: org owners full access"
  on public.clients for all
  using (
    exists (
      select 1 from public.organizations org
      where org.id = clients.organization_id
        and org.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.organizations org
      where org.id = clients.organization_id
        and org.owner_id = auth.uid()
    )
  );

-- Invoices policies
drop policy if exists "Invoices: org owners full access" on public.invoices;
create policy "Invoices: org owners full access"
  on public.invoices for all
  using (
    exists (
      select 1 from public.organizations org
      where org.id = invoices.organization_id
        and org.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.organizations org
      where org.id = invoices.organization_id
        and org.owner_id = auth.uid()
    )
  );

-- Reminder Logs policies
drop policy if exists "Reminder logs: org owners full access" on public.reminder_logs;
create policy "Reminder logs: org owners full access"
  on public.reminder_logs for all
  using (
    exists (
      select 1 from public.organizations org
      where org.id = reminder_logs.organization_id
        and org.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.organizations org
      where org.id = reminder_logs.organization_id
        and org.owner_id = auth.uid()
    )
  );
