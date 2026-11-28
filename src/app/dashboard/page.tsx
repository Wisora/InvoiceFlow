'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  FileSpreadsheet,
  Flag,
  History,
  Loader2,
  LogOut,
  Mail,
  MessageCircle,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';
import { isSupabaseConfigured, supabase } from '@/lib/supabaseClient';
import {
  buildWhatsAppChaseUrl,
  computeClientReliability,
  formatCurrency,
  formatDate,
  getDaysOverdue,
  getEffectiveInvoiceStatus,
  getTodayIsoDate,
} from '@/lib/formatters';
import {
  getReminderLogClearedAt,
  setReminderLogClearedAt,
} from '@/lib/reminderLogClearStorage';
import type {
  Client,
  Invoice,
  InvoiceStatus,
  Organization,
  ReliabilityLabel,
  ReminderLog,
} from '@/lib/types';
import CreateInvoiceModal from '@/components/CreateInvoiceModal';
import CsvImportModal from '@/components/CsvImportModal';

type WorkspaceTab = 'invoices' | 'clients' | 'logs';
type InvoiceFilter = 'all' | 'overdue' | 'sent' | 'draft' | 'paid' | 'disputed';

interface ToastState {
  id: number;
  type: 'success' | 'error';
  message: string;
}

export default function DashboardPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [reminderLogs, setReminderLogs] = useState<ReminderLog[]>([]);

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('invoices');
  const [statusFilter, setStatusFilter] = useState<InvoiceFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Client-side localStorage clear state for Reminder Log view (never deletes DB rows)
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const [showClearedLogs, setShowClearedLogs] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCsvModal, setShowCsvModal] = useState(false);

  // Add client inline panel on Clients tab
  const [showAddClientForm, setShowAddClientForm] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientCompany, setNewClientCompany] = useState('');
  const [newClientEmail, setNewClientEmail] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [savingClient, setSavingClient] = useState(false);

  // Per-row action loading states
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [runningCron, setRunningCron] = useState(false);

  const [toast, setToast] = useState<ToastState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const pushToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = Date.now();
    setToast({ id, type, message });
    setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, 5000);
  }, []);

  const loadWorkspaceData = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setLoadError(
        'Supabase environment variables are not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to connect your workspace.'
      );
      setLoading(false);
      return;
    }

    setLoadError(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const user = sessionData.session?.user;
      if (!user) {
        router.replace('/login');
        return;
      }

      // 1. Resolve or provision Organization
      let { data: org, error: orgErr } = await supabase
        .from('organizations')
        .select('*')
        .eq('owner_id', user.id)
        .limit(1)
        .maybeSingle();

      if (orgErr) throw orgErr;

      if (!org) {
        const metaName =
          (user.user_metadata?.organization_name as string | undefined) ||
          `${(user.email || 'Acme').split('@')[0]} Holdings`;
        const { data: createdOrg, error: createOrgErr } = await supabase
          .from('organizations')
          .insert({
            owner_id: user.id,
            name: metaName,
            contact_email: user.email ?? null,
            default_currency: 'ZAR',
          })
          .select('*')
          .single();

        if (createOrgErr) throw createOrgErr;
        org = createdOrg;
      }

      const typedOrg = org as Organization;
      setOrganization(typedOrg);
      setClearedAt(getReminderLogClearedAt(typedOrg.id));

      // 2. Fetch clients, invoices, and reminder_logs in parallel
      const [clientsRes, invoicesRes, logsRes] = await Promise.all([
        supabase
          .from('clients')
          .select('*')
          .eq('organization_id', typedOrg.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('invoices')
          .select('*, client:clients(*)')
          .eq('organization_id', typedOrg.id)
          .order('due_date', { ascending: true }),
        supabase
          .from('reminder_logs')
          .select('*, invoice:invoices(invoice_number)')
          .eq('organization_id', typedOrg.id)
          .order('sent_at', { ascending: false })
          .limit(100),
      ]);

      if (clientsRes.error) throw clientsRes.error;
      if (invoicesRes.error) throw invoicesRes.error;
      if (logsRes.error) throw logsRes.error;

      setClients((clientsRes.data ?? []) as Client[]);
      setInvoices((invoicesRes.data ?? []) as Invoice[]);
      setReminderLogs((logsRes.data ?? []) as ReminderLog[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load dashboard data.';
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadWorkspaceData();
  }, [loadWorkspaceData]);

  // Dynamically compute each client's reliability label from historical invoice payment dates
  const clientReliabilityMap = useMemo(() => {
    const grouped = new Map<string, Invoice[]>();
    for (const inv of invoices) {
      const list = grouped.get(inv.client_id) ?? [];
      list.push(inv);
      grouped.set(inv.client_id, list);
    }

    const labels = new Map<string, ReliabilityLabel>();
    for (const c of clients) {
      const history = grouped.get(c.id) ?? [];
      labels.set(
        c.id,
        history.length > 0 ? computeClientReliability(history) : c.reliability_label
      );
    }
    return labels;
  }, [clients, invoices]);

  // Compute KPI metrics
  const kpis = useMemo(() => {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const todayIso = getTodayIsoDate();
    const forecastCutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14);
    const forecastCutoffIso = `${forecastCutoff.getFullYear()}-${String(
      forecastCutoff.getMonth() + 1
    ).padStart(2, '0')}-${String(forecastCutoff.getDate()).padStart(2, '0')}`;

    let totalOutstanding = 0;
    let outstandingCount = 0;
    let overdueAmount = 0;
    let overdueCount = 0;
    let collectedThisMonth = 0;
    let collectedCount = 0;
    let forecast14Day = 0;
    let forecastCount = 0;

    for (const inv of invoices) {
      const amt = Number(inv.amount) || 0;
      const effectiveStatus = getEffectiveInvoiceStatus(inv);

      if (effectiveStatus === 'sent' || effectiveStatus === 'overdue') {
        totalOutstanding += amt;
        outstandingCount += 1;

        if (effectiveStatus === 'overdue') {
          overdueAmount += amt;
          overdueCount += 1;
        }

        // 14-Day Cash Forecast includes non-disputed unpaid invoices due or promised within 14 days
        const hasDispute = Boolean(inv.dispute_note && inv.dispute_note.trim().length > 0);
        if (!hasDispute) {
          const expectedDate = inv.promised_pay_date || inv.due_date;
          if (expectedDate <= forecastCutoffIso && expectedDate >= todayIso) {
            forecast14Day += amt;
            forecastCount += 1;
          } else if (!inv.promised_pay_date && inv.due_date < todayIso) {
            // Unpromised overdue invoices expected to be actively chased in the 14-day window (weighted 50% conservative recovery)
            forecast14Day += amt * 0.5;
            forecastCount += 1;
          }
        }
      }

      if (effectiveStatus === 'paid' && inv.paid_at) {
        const paidDate = new Date(inv.paid_at);
        if (
          paidDate.getMonth() === currentMonth &&
          paidDate.getFullYear() === currentYear
        ) {
          collectedThisMonth += amt;
          collectedCount += 1;
        }
      }
    }

    return {
      totalOutstanding,
      outstandingCount,
      overdueAmount,
      overdueCount,
      collectedThisMonth,
      collectedCount,
      forecast14Day,
      forecastCount,
    };
  }, [invoices]);

  const filteredInvoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return invoices.filter((inv) => {
      const effectiveStatus = getEffectiveInvoiceStatus(inv);
      const hasDispute = Boolean(inv.dispute_note && inv.dispute_note.trim().length > 0);

      if (statusFilter === 'disputed' && !hasDispute) return false;
      if (
        statusFilter !== 'all' &&
        statusFilter !== 'disputed' &&
        effectiveStatus !== statusFilter
      ) {
        return false;
      }

      if (!q) return true;
      const hay = [
        inv.invoice_number,
        inv.description,
        inv.client?.name ?? '',
        inv.client?.company ?? '',
        inv.client?.email ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [invoices, searchQuery, statusFilter]);

  // Filter reminder logs locally when user clicks "Clear Log" while keeping rows in Supabase
  const visibleReminderLogs = useMemo(() => {
    if (showClearedLogs || !clearedAt) return reminderLogs;
    const cutoffMs = new Date(clearedAt).getTime();
    if (Number.isNaN(cutoffMs)) return reminderLogs;
    return reminderLogs.filter((log) => new Date(log.sent_at).getTime() > cutoffMs);
  }, [reminderLogs, clearedAt, showClearedLogs]);

  function handleClearReminderLog() {
    if (!organization) return;
    const nowIso = new Date().toISOString();
    setReminderLogClearedAt(organization.id, nowIso);
    setClearedAt(nowIso);
    setShowClearedLogs(false);
    pushToast(
      'success',
      'Reminder log view cleared. Audit history remains saved in Supabase.'
    );
  }

  function handleRestoreReminderLog() {
    if (!organization) return;
    setReminderLogClearedAt(organization.id, null);
    setClearedAt(null);
    setShowClearedLogs(false);
    pushToast('success', 'Reminder log clear filter reset.');
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace('/login');
  }

  async function handleSendManualReminder(invoice: Invoice) {
    setRemindingId(invoice.id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        router.replace('/login');
        return;
      }

      const res = await fetch('/api/invoices/remind', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ invoiceId: invoice.id }),
      });

      const payload = (await res.json()) as {
        ok?: boolean;
        error?: string;
        sentAt?: string;
        status?: InvoiceStatus;
      };

      if (!res.ok) {
        pushToast('error', payload.error || 'Failed to send reminder email.');
        return;
      }

      pushToast(
        'success',
        `Reminder email dispatched to ${invoice.client?.email ?? 'client'} for ${invoice.invoice_number}.`
      );
      await loadWorkspaceData();
    } catch (err) {
      pushToast(
        'error',
        err instanceof Error ? err.message : 'Network error sending reminder.'
      );
    } finally {
      setRemindingId(null);
    }
  }

  async function handleRunChaserSweep() {
    setRunningCron(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        router.replace('/login');
        return;
      }

      const res = await fetch('/api/cron/chaser', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = (await res.json()) as {
        ok?: boolean;
        sent?: number;
        skipped_disputed?: number;
        skipped_promised?: number;
        error?: string;
      };

      if (!res.ok) {
        pushToast('error', data.error || 'Automated chaser sweep failed.');
        return;
      }

      pushToast(
        'success',
        `Chaser sweep complete: ${data.sent ?? 0} sent · ${data.skipped_promised ?? 0} promised paused · ${data.skipped_disputed ?? 0} disputed skipped.`
      );
      await loadWorkspaceData();
    } catch (err) {
      pushToast(
        'error',
        err instanceof Error ? err.message : 'Failed to run chaser sweep.'
      );
    } finally {
      setRunningCron(false);
    }
  }

  async function handleMarkPaid(invoice: Invoice) {
    setMarkingPaidId(invoice.id);
    try {
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from('invoices')
        .update({
          status: 'paid',
          paid_at: nowIso,
          promised_pay_date: null,
        })
        .eq('id', invoice.id);

      if (error) throw error;

      pushToast('success', `Invoice ${invoice.invoice_number} marked as paid.`);
      await loadWorkspaceData();
    } catch (err) {
      pushToast(
        'error',
        err instanceof Error ? err.message : 'Failed to update invoice status.'
      );
    } finally {
      setMarkingPaidId(null);
    }
  }

  async function handleAddClient(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!organization) return;

    if (!newClientName.trim() || !newClientEmail.trim()) {
      pushToast('error', 'Client name and email are required.');
      return;
    }

    setSavingClient(true);
    try {
      const { error } = await supabase.from('clients').insert({
        organization_id: organization.id,
        name: newClientName.trim(),
        company: newClientCompany.trim() || null,
        email: newClientEmail.trim(),
        phone: newClientPhone.trim() || null,
        reliability_label: 'On-Time',
      });

      if (error) throw error;

      setNewClientName('');
      setNewClientCompany('');
      setNewClientEmail('');
      setNewClientPhone('');
      setShowAddClientForm(false);
      pushToast('success', 'Client added to directory.');
      await loadWorkspaceData();
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : 'Failed to add client.');
    } finally {
      setSavingClient(false);
    }
  }

  function handleCopyPayLink(invoiceId: string) {
    const url = `${window.location.origin}/pay/${invoiceId}`;
    navigator.clipboard.writeText(url);
    setCopiedId(invoiceId);
    setTimeout(() => setCopiedId((prev) => (prev === invoiceId ? null : prev)), 2000);
  }

  const baseCurrency = organization?.default_currency || 'ZAR';

  return (
    <div className="min-h-screen">
      {/* Top Bar Contract: Brand wordmark — Concise nav links — 1 Primary action */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-8 px-6 py-3.5">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0"
          >
            <Receipt className="h-5 w-5 text-emerald-400" />
            <span>InvoiceFlow</span>
          </Link>

          <nav className="hidden items-center gap-6 text-sm font-medium md:flex">
            <button
              type="button"
              onClick={() => setActiveTab('invoices')}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'invoices'
                  ? 'text-slate-50 underline decoration-emerald-400 decoration-2 underline-offset-8'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Invoices
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('clients')}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'clients'
                  ? 'text-slate-50 underline decoration-emerald-400 decoration-2 underline-offset-8'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Clients
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('logs')}
              className={`transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'logs'
                  ? 'text-slate-50 underline decoration-emerald-400 decoration-2 underline-offset-8'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              Reminder Log
            </button>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              disabled={!organization}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Invoice</span>
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="rounded-xl border border-slate-800 p-2 text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-100"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-8">
        {/* Toast feedback */}
        {toast && (
          <div
            role="status"
            className={`flex items-center justify-between rounded-xl border px-4 py-3 text-xs font-medium ${
              toast.type === 'success'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {toast.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 text-rose-400" />
              )}
              <span>{toast.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-slate-400 hover:text-slate-100"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Workspace Sub-header & Utility Toolbar */}
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-50">
              {organization?.name || 'Accounts Receivable'}
            </h1>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
              <span>{clients.length} active clients</span>
              <span aria-hidden="true">·</span>
              <span>Default currency {baseCurrency}</span>
              <span aria-hidden="true">·</span>
              <span>Paystack &amp; Resend automated chasing</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowCsvModal(true)}
              disabled={!organization}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/70 px-3.5 py-2 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-700 hover:bg-slate-800/80 disabled:opacity-50 whitespace-nowrap"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
              <span>Import CSV</span>
            </button>
            <button
              type="button"
              onClick={handleRunChaserSweep}
              disabled={runningCron || !organization}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/70 px-3.5 py-2 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-700 hover:bg-slate-800/80 disabled:opacity-50 whitespace-nowrap"
            >
              {runningCron ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 text-emerald-400" />
              )}
              <span>{runningCron ? 'Sweeping...' : 'Run Chaser Sweep'}</span>
            </button>
          </div>
        </div>

        {/* Mobile Tab Switcher */}
        <div className="grid grid-cols-3 gap-1 rounded-xl border border-slate-800/80 bg-slate-900/60 p-1 md:hidden">
          {(['invoices', 'clients', 'logs'] as WorkspaceTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`rounded-lg py-2 text-xs font-semibold capitalize transition-colors ${
                activeTab === tab
                  ? 'bg-slate-800 text-slate-50'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab === 'logs' ? 'Reminder Log' : tab}
            </button>
          ))}
        </div>

        {loadError && (
          <div className="glass-panel flex items-start gap-3 rounded-2xl border-amber-500/30 p-5 text-sm text-amber-200">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div>
              <p className="font-semibold text-amber-100">Workspace connection notice</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-200/80">{loadError}</p>
            </div>
          </div>
        )}

        {/* 4 KPI Summary Cards */}
        <section
          aria-label="Receivables Summary"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <div className="glass-panel rounded-2xl p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>Total Outstanding</span>
              <Wallet className="h-4 w-4 text-slate-500" />
            </div>
            <div className="mt-3 font-mono text-2xl font-bold tabular-nums text-slate-50">
              {loading ? '—' : formatCurrency(kpis.totalOutstanding, baseCurrency)}
            </div>
            <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
              {kpis.outstandingCount} unpaid invoice{kpis.outstandingCount === 1 ? '' : 's'}
            </p>
          </div>

          <div className="glass-panel rounded-2xl p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>Overdue Amount</span>
              <ShieldAlert className="h-4 w-4 text-rose-400" />
            </div>
            <div className="mt-3 font-mono text-2xl font-bold tabular-nums text-rose-400">
              {loading ? '—' : formatCurrency(kpis.overdueAmount, baseCurrency)}
            </div>
            <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
              {kpis.overdueCount} past due date
            </p>
          </div>

          <div className="glass-panel rounded-2xl p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>Collected This Month</span>
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="mt-3 font-mono text-2xl font-bold tabular-nums text-emerald-400">
              {loading ? '—' : formatCurrency(kpis.collectedThisMonth, baseCurrency)}
            </div>
            <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
              {kpis.collectedCount} settled this month
            </p>
          </div>

          <div className="glass-panel rounded-2xl p-5">
            <div className="flex items-center justify-between text-xs font-medium text-slate-400">
              <span>14-Day Cash Forecast</span>
              <TrendingUp className="h-4 w-4 text-sky-400" />
            </div>
            <div className="mt-3 font-mono text-2xl font-bold tabular-nums text-sky-300">
              {loading ? '—' : formatCurrency(kpis.forecast14Day, baseCurrency)}
            </div>
            <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
              {kpis.forecastCount} due or promised in 14d
            </p>
          </div>
        </section>

        {/* TAB 1: INVOICES */}
        {activeTab === 'invoices' && (
          <section className="glass-panel overflow-hidden rounded-2xl">
            <div className="flex flex-col justify-between gap-4 border-b border-slate-800/80 px-5 py-4 lg:flex-row lg:items-center">
              <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-800/90 bg-slate-950/60 p-1">
                {(
                  [
                    { key: 'all', label: 'All' },
                    { key: 'overdue', label: 'Overdue' },
                    { key: 'sent', label: 'Sent' },
                    { key: 'draft', label: 'Draft' },
                    { key: 'paid', label: 'Paid' },
                    { key: 'disputed', label: 'Disputed' },
                  ] as Array<{ key: InvoiceFilter; label: string }>
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setStatusFilter(tab.key)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      statusFilter === tab.key
                        ? 'bg-slate-800 text-slate-50 shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="relative w-full lg:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search invoice # or client..."
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 py-2 pl-9 pr-3 text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
                />
              </div>
            </div>

            {loading ? (
              <div className="space-y-3 p-6">
                {[1, 2, 3, 4].map((row) => (
                  <div
                    key={row}
                    className="h-12 animate-pulse rounded-xl bg-slate-900/60"
                  />
                ))}
              </div>
            ) : filteredInvoices.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                <Receipt className="mb-3 h-8 w-8 text-slate-600" />
                <h3 className="text-sm font-semibold text-slate-200">
                  {invoices.length === 0
                    ? 'No invoices created yet'
                    : 'No invoices match the current filter'}
                </h3>
                <p className="mt-1 max-w-sm text-xs text-slate-400">
                  {invoices.length === 0
                    ? 'Create your first invoice or import a CSV ledger to activate automated Paystack & email chasing.'
                    : 'Clear your search query or switch status filters to see other receivables.'}
                </p>
                {invoices.length === 0 && (
                  <div className="mt-5 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setShowCreateModal(true)}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Create First Invoice</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCsvModal(true)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800/60"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      <span>Import CSV</span>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-left text-xs">
                  <thead className="border-b border-slate-800/80 bg-slate-950/50 text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-medium">Invoice</th>
                      <th className="px-5 py-3 font-medium">Client &amp; Reliability</th>
                      <th className="px-5 py-3 font-medium">Due Date</th>
                      <th className="px-5 py-3 text-right font-medium">Amount</th>
                      <th className="px-5 py-3 font-medium">Status &amp; Flags</th>
                      <th className="px-5 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {filteredInvoices.map((inv) => {
                      const effectiveStatus = getEffectiveInvoiceStatus(inv);
                      const daysOver = getDaysOverdue(inv.due_date);
                      const isUnpaid =
                        effectiveStatus === 'sent' ||
                        effectiveStatus === 'overdue' ||
                        effectiveStatus === 'draft';
                      const reliability =
                        clientReliabilityMap.get(inv.client_id) ??
                        inv.client?.reliability_label ??
                        'On-Time';
                      const hasDispute = Boolean(
                        inv.dispute_note && inv.dispute_note.trim().length > 0
                      );
                      const payPath = `/pay/${inv.id}`;
                      const fullPayUrl =
                        typeof window !== 'undefined'
                          ? `${window.location.origin}${payPath}`
                          : payPath;

                      const whatsappUrl = buildWhatsAppChaseUrl({
                        phone: inv.client?.phone,
                        clientName: inv.client?.name || 'there',
                        organizationName: organization?.name || 'Our team',
                        invoiceNumber: inv.invoice_number,
                        amountFormatted: formatCurrency(Number(inv.amount), inv.currency),
                        dueDate: inv.due_date,
                        payUrl: fullPayUrl,
                      });

                      return (
                        <tr
                          key={inv.id}
                          className="transition-colors hover:bg-slate-900/50"
                        >
                          <td className="px-5 py-3.5 align-top">
                            <div className="font-mono font-semibold text-slate-100">
                              {inv.invoice_number}
                            </div>
                            <div className="mt-0.5 max-w-[200px] truncate text-[11px] text-slate-400">
                              {inv.description}
                            </div>
                          </td>

                          <td className="px-5 py-3.5 align-top">
                            <div className="font-medium text-slate-200">
                              {inv.client?.name ?? 'Unknown Client'}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                              {inv.client?.company && <span>{inv.client.company}</span>}
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                  reliability === 'On-Time'
                                    ? 'bg-emerald-500/10 text-emerald-300'
                                    : reliability === 'Slow Payer'
                                    ? 'bg-amber-500/10 text-amber-300'
                                    : 'bg-rose-500/10 text-rose-300'
                                }`}
                              >
                                {reliability}
                              </span>
                            </div>
                          </td>

                          <td className="px-5 py-3.5 align-top tabular-nums">
                            <div className="text-slate-200">{formatDate(inv.due_date)}</div>
                            {effectiveStatus === 'overdue' && daysOver > 0 && (
                              <div className="mt-0.5 text-[11px] font-medium text-rose-400">
                                {daysOver}d overdue
                              </div>
                            )}
                            {inv.last_reminded_at && (
                              <div className="mt-0.5 text-[11px] text-slate-500">
                                Reminded {formatDate(inv.last_reminded_at)}
                              </div>
                            )}
                          </td>

                          <td className="px-5 py-3.5 text-right align-top font-mono font-semibold tabular-nums text-slate-100">
                            {formatCurrency(Number(inv.amount), inv.currency)}
                          </td>

                          <td className="px-5 py-3.5 align-top">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize ${
                                  effectiveStatus === 'paid'
                                    ? 'bg-emerald-500/15 text-emerald-300'
                                    : effectiveStatus === 'overdue'
                                    ? 'bg-rose-500/15 text-rose-300'
                                    : effectiveStatus === 'sent'
                                    ? 'bg-sky-500/15 text-sky-300'
                                    : 'bg-slate-800 text-slate-300'
                                }`}
                              >
                                {effectiveStatus === 'paid' && (
                                  <Check className="h-3 w-3" />
                                )}
                                {effectiveStatus === 'overdue' && (
                                  <Clock className="h-3 w-3" />
                                )}
                                {effectiveStatus}
                              </span>

                              {inv.promised_pay_date && effectiveStatus !== 'paid' && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                                  <CalendarClock className="h-3 w-3" />
                                  Promised {formatDate(inv.promised_pay_date)}
                                </span>
                              )}

                              {hasDispute && (
                                <span
                                  title={inv.dispute_note ?? undefined}
                                  className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-300"
                                >
                                  <Flag className="h-3 w-3" />
                                  Disputed
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="px-5 py-3.5 text-right align-top">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {isUnpaid && (
                                <button
                                  type="button"
                                  onClick={() => handleSendManualReminder(inv)}
                                  disabled={remindingId === inv.id}
                                  title="Send reminder email"
                                  className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 transition-colors hover:border-slate-700 hover:bg-slate-800 disabled:opacity-50"
                                >
                                  {remindingId === inv.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Send className="h-3 w-3 text-emerald-400" />
                                  )}
                                  <span>Remind</span>
                                </button>
                              )}

                              {whatsappUrl && isUnpaid && (
                                <a
                                  href={whatsappUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="Open WhatsApp reminder"
                                  className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-900/80 p-1.5 text-emerald-400 transition-colors hover:border-slate-700 hover:bg-slate-800"
                                >
                                  <MessageCircle className="h-3.5 w-3.5" />
                                </a>
                              )}

                              <button
                                type="button"
                                onClick={() => handleCopyPayLink(inv.id)}
                                title="Copy payment link"
                                className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-900/80 p-1.5 text-slate-300 transition-colors hover:border-slate-700 hover:bg-slate-800"
                              >
                                {copiedId === inv.id ? (
                                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                              </button>

                              <Link
                                href={payPath}
                                target="_blank"
                                title="Open hosted payment page"
                                className="inline-flex items-center rounded-lg border border-slate-800 bg-slate-900/80 p-1.5 text-slate-300 transition-colors hover:border-slate-700 hover:bg-slate-800"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </Link>

                              {effectiveStatus !== 'paid' && (
                                <button
                                  type="button"
                                  onClick={() => handleMarkPaid(inv)}
                                  disabled={markingPaidId === inv.id}
                                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
                                >
                                  {markingPaidId === inv.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="h-3 w-3" />
                                  )}
                                  <span>Mark Paid</span>
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* TAB 2: CLIENTS */}
        {activeTab === 'clients' && (
          <section className="glass-panel overflow-hidden rounded-2xl">
            <div className="flex flex-col justify-between gap-3 border-b border-slate-800/80 px-5 py-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-slate-100">Client Directory</h2>
              </div>

              <button
                type="button"
                onClick={() => setShowAddClientForm((prev) => !prev)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/80 px-3.5 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-700 hover:bg-slate-800"
              >
                <UserPlus className="h-3.5 w-3.5 text-emerald-400" />
                <span>{showAddClientForm ? 'Close Form' : 'Add Client'}</span>
              </button>
            </div>

            {showAddClientForm && (
              <form
                onSubmit={handleAddClient}
                className="grid grid-cols-1 gap-3 border-b border-slate-800/80 bg-slate-950/50 px-5 py-4 sm:grid-cols-2 lg:grid-cols-5"
              >
                <input
                  type="text"
                  required
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  placeholder="Client name *"
                  className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/60 focus:outline-none"
                />
                <input
                  type="text"
                  value={newClientCompany}
                  onChange={(e) => setNewClientCompany(e.target.value)}
                  placeholder="Company"
                  className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/60 focus:outline-none"
                />
                <input
                  type="email"
                  required
                  value={newClientEmail}
                  onChange={(e) => setNewClientEmail(e.target.value)}
                  placeholder="Email *"
                  className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/60 focus:outline-none"
                />
                <input
                  type="tel"
                  value={newClientPhone}
                  onChange={(e) => setNewClientPhone(e.target.value)}
                  placeholder="Phone (e.g. +27...)"
                  className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/60 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={savingClient}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
                >
                  {savingClient && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>{savingClient ? 'Saving...' : 'Save Client'}</span>
                </button>
              </form>
            )}

            {clients.length === 0 ? (
              <div className="px-6 py-14 text-center text-xs text-slate-400">
                No clients yet. Click &ldquo;Add Client&rdquo; or create an invoice to add one.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="border-b border-slate-800/80 bg-slate-950/50 text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-medium">Client</th>
                      <th className="px-5 py-3 font-medium">Contact</th>
                      <th className="px-5 py-3 font-medium">Reliability</th>
                      <th className="px-5 py-3 text-right font-medium">Open Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {clients.map((client) => {
                      const reliability =
                        clientReliabilityMap.get(client.id) ?? client.reliability_label;
                      const clientInvoices = invoices.filter(
                        (i) => i.client_id === client.id
                      );
                      const openBalance = clientInvoices.reduce((acc, inv) => {
                        const st = getEffectiveInvoiceStatus(inv);
                        return st === 'sent' || st === 'overdue'
                          ? acc + (Number(inv.amount) || 0)
                          : acc;
                      }, 0);

                      return (
                        <tr key={client.id} className="hover:bg-slate-900/50">
                          <td className="px-5 py-3.5">
                            <div className="font-semibold text-slate-100">{client.name}</div>
                            {client.company && (
                              <div className="text-[11px] text-slate-400">
                                {client.company}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-slate-300">
                            <div className="flex items-center gap-1.5">
                              <Mail className="h-3 w-3 text-slate-500" />
                              <span>{client.email}</span>
                            </div>
                            {client.phone && (
                              <div className="mt-0.5 text-[11px] text-slate-400">
                                {client.phone}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3.5">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                                reliability === 'On-Time'
                                  ? 'bg-emerald-500/10 text-emerald-300'
                                  : reliability === 'Slow Payer'
                                  ? 'bg-amber-500/10 text-amber-300'
                                  : 'bg-rose-500/10 text-rose-300'
                              }`}
                            >
                              {reliability}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-right font-mono font-semibold tabular-nums text-slate-100">
                            {formatCurrency(openBalance, baseCurrency)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* TAB 3: REMINDER LOG */}
        {activeTab === 'logs' && (
          <section className="glass-panel overflow-hidden rounded-2xl">
            <div className="flex flex-col justify-between gap-3 border-b border-slate-800/80 px-5 py-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-emerald-400" />
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    Automated &amp; Manual Chaser Audit Log
                  </h2>
                  <p className="text-[11px] text-slate-400">
                    Showing {visibleReminderLogs.length} of {reminderLogs.length} entries
                    {clearedAt && !showClearedLogs
                      ? ` · Cleared since ${formatDate(clearedAt)}`
                      : ''}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {clearedAt && (
                  <button
                    type="button"
                    onClick={() => setShowClearedLogs((prev) => !prev)}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-700 hover:bg-slate-800"
                  >
                    {showClearedLogs ? 'Hide Cleared' : 'Show Full History'}
                  </button>
                )}

                {clearedAt && (
                  <button
                    type="button"
                    onClick={handleRestoreReminderLog}
                    className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-700 hover:bg-slate-800"
                  >
                    Reset Clear
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleClearReminderLog}
                  disabled={!organization || visibleReminderLogs.length === 0}
                  className="rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-700 hover:bg-slate-800 disabled:opacity-50"
                >
                  Clear Log
                </button>
              </div>
            </div>

            {visibleReminderLogs.length === 0 ? (
              <div className="px-6 py-14 text-center text-xs text-slate-400">
                {reminderLogs.length === 0
                  ? 'No reminders dispatched yet. Use "Remind" on an invoice or "Run Chaser Sweep".'
                  : 'All current reminder log entries have been cleared from this view. Use "Show Full History" or "Reset Clear" to restore them.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-xs">
                  <thead className="border-b border-slate-800/80 bg-slate-950/50 text-slate-400">
                    <tr>
                      <th className="px-5 py-3 font-medium">Sent At</th>
                      <th className="px-5 py-3 font-medium">Invoice</th>
                      <th className="px-5 py-3 font-medium">Template</th>
                      <th className="px-5 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {visibleReminderLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-900/50">
                        <td className="px-5 py-3.5 tabular-nums text-slate-300">
                          {new Date(log.sent_at).toLocaleString()}
                        </td>
                        <td className="px-5 py-3.5 font-mono font-medium text-slate-100">
                          {log.invoice?.invoice_number ?? log.invoice_id}
                        </td>
                        <td className="px-5 py-3.5 font-mono text-[11px] text-slate-300">
                          {log.template_used}
                        </td>
                        <td className="px-5 py-3.5">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold capitalize ${
                              log.status === 'sent'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-rose-500/15 text-rose-300'
                            }`}
                          >
                            {log.status === 'sent' ? (
                              <CheckCircle2 className="h-3 w-3" />
                            ) : (
                              <XCircle className="h-3 w-3" />
                            )}
                            {log.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>

      {organization && (
        <>
          <CreateInvoiceModal
            isOpen={showCreateModal}
            onClose={() => setShowCreateModal(false)}
            organization={organization}
            clients={clients}
            onCreated={async () => {
              pushToast('success', 'Invoice created.');
              await loadWorkspaceData();
            }}
          />

          <CsvImportModal
            isOpen={showCsvModal}
            onClose={() => setShowCsvModal(false)}
            organization={organization}
            onImported={async (count) => {
              pushToast(
                'success',
                `Imported ${count} invoice${count === 1 ? '' : 's'} from CSV.`
              );
              await loadWorkspaceData();
            }}
          />
        </>
      )}
    </div>
  );
}