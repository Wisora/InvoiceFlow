'use client';

import { useState } from 'react';
import { Loader2, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { formatCurrency, getTodayIsoDate } from '@/lib/formatters';
import type { Client, Invoice, LineItem } from '@/lib/types';

interface CreateInvoiceModalProps {
  open: boolean;
  organizationId: string;
  defaultCurrency?: string;
  clients: Client[];
  onClose: () => void;
  onCreated: (payload: { client?: Client; invoice: Invoice }) => void;
}

export default function CreateInvoiceModal({
  open,
  organizationId,
  defaultCurrency = 'ZAR',
  clients,
  onClose,
  onCreated,
}: CreateInvoiceModalProps) {
  const [clientMode, setClientMode] = useState<'existing' | 'new'>(
    clients.length > 0 ? 'existing' : 'new'
  );
  const [selectedClientId, setSelectedClientId] = useState<string>(clients[0]?.id ?? '');

  // New client fields
  const [clientName, setClientName] = useState('');
  const [clientCompany, setClientCompany] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientPhone, setClientPhone] = useState('');

  // Invoice fields
  const [invoiceNumber, setInvoiceNumber] = useState(
    `INV-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`
  );
  const [description, setDescription] = useState('Monthly Retainer & Platform Services');
  const [currency, setCurrency] = useState(defaultCurrency || 'ZAR');
  const [issueDate, setIssueDate] = useState(getTodayIsoDate());
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [status, setStatus] = useState<'sent' | 'draft'>('sent');
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { description: 'Core B2B SaaS Subscription', quantity: 1, unit_price: 12500 },
  ]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const totalAmount = lineItems.reduce(
    (sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0),
    0
  );

  function addLineItem() {
    setLineItems((prev) => [...prev, { description: '', quantity: 1, unit_price: 0 }]);
  }

  function removeLineItem(index: number) {
    if (lineItems.length <= 1) return;
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  }

  function updateLineItem(index: number, patch: Partial<LineItem>) {
    setLineItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, ...patch } : item))
    );
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!invoiceNumber.trim() || !description.trim()) {
      setError('Invoice number and description are required.');
      return;
    }

    if (totalAmount <= 0) {
      setError('Total invoice amount must be greater than zero.');
      return;
    }

    setSubmitting(true);

    try {
      let resolvedClientId = selectedClientId;
      let createdClient: Client | undefined;

      if (clientMode === 'new' || !resolvedClientId) {
        if (!clientName.trim() || !clientEmail.trim()) {
          setError('Client name and email are required.');
          setSubmitting(false);
          return;
        }

        const { data: newClient, error: clientErr } = await supabase
          .from('clients')
          .insert({
            organization_id: organizationId,
            name: clientName.trim(),
            company: clientCompany.trim() || null,
            email: clientEmail.trim(),
            phone: clientPhone.trim() || null,
            reliability_label: 'On-Time',
          })
          .select('*')
          .single();

        if (clientErr) throw clientErr;
        createdClient = newClient as Client;
        resolvedClientId = createdClient.id;
      }

      const sanitizedItems = lineItems.filter(
        (li) => li.description.trim() && Number(li.quantity) > 0 && Number(li.unit_price) > 0
      );

      const effectiveStatus =
        status === 'sent' && dueDate < getTodayIsoDate() ? 'overdue' : status;

      const { data: newInvoice, error: invErr } = await supabase
        .from('invoices')
        .insert({
          organization_id: organizationId,
          client_id: resolvedClientId,
          invoice_number: invoiceNumber.trim(),
          description: description.trim(),
          line_items:
            sanitizedItems.length > 0
              ? sanitizedItems
              : [{ description: description.trim(), quantity: 1, unit_price: totalAmount }],
          amount: Number(totalAmount.toFixed(2)),
          currency: currency.toUpperCase(),
          status: effectiveStatus,
          issue_date: issueDate,
          due_date: dueDate,
        })
        .select('*, client:clients(*)')
        .single();

      if (invErr) throw invErr;

      onCreated({
        client: createdClient,
        invoice: newInvoice as Invoice,
      });
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create invoice.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-950/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-invoice-title"
    >
      <div className="glass-panel flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-slate-800/90 bg-slate-950/95">
        <div className="flex items-center justify-between border-b border-slate-800/80 px-6 py-4">
          <div>
            <h2 id="create-invoice-title" className="text-lg font-semibold text-slate-50">
              Create Invoice
            </h2>
            <p className="text-xs text-slate-400">
              Issue a receivable and attach an automated Paystack payment link
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close slide-over"
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800/70 hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
              {error}
            </div>
          )}

          {/* Client selection or inline creation */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">Client Details</span>
              {clients.length > 0 && (
                <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-0.5">
                  <button
                    type="button"
                    onClick={() => setClientMode('existing')}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      clientMode === 'existing'
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Existing Client
                  </button>
                  <button
                    type="button"
                    onClick={() => setClientMode('new')}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      clientMode === 'new'
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <UserPlus className="h-3 w-3" />
                    New Client
                  </button>
                </div>
              )}
            </div>

            {clientMode === 'existing' && clients.length > 0 ? (
              <div>
                <select
                  value={selectedClientId}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3.5 py-2.5 text-sm text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.company ? ` — ${c.company}` : ''} ({c.email})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Contact Name *</label>
                  <input
                    type="text"
                    required
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="Thabo Mokoena"
                    className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Company</label>
                  <input
                    type="text"
                    value={clientCompany}
                    onChange={(e) => setClientCompany(e.target.value)}
                    placeholder="Vula Freight (Pty) Ltd"
                    className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">Billing Email *</label>
                  <input
                    type="email"
                    required
                    value={clientEmail}
                    onChange={(e) => setClientEmail(e.target.value)}
                    placeholder="accounts@vulafreight.co.za"
                    className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-slate-400">
                    WhatsApp Phone
                  </label>
                  <input
                    type="tel"
                    value={clientPhone}
                    onChange={(e) => setClientPhone(e.target.value)}
                    placeholder="+27821234567"
                    className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm font-mono text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
                  />
                </div>
              </div>
            )}
          </section>

          {/* Invoice Metadata */}
          <section className="space-y-3 border-t border-slate-800/80 pt-5">
            <span className="block text-xs font-semibold text-slate-300">
              Invoice Metadata
            </span>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Invoice # *</label>
                <input
                  type="text"
                  required
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm font-mono text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Currency</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm font-mono text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                >
                  <option value="ZAR">ZAR (R)</option>
                  <option value="USD">USD ($)</option>
                  <option value="NGN">NGN (₦)</option>
                  <option value="KES">KES (KSh)</option>
                  <option value="GHS">GHS (₵)</option>
                  <option value="GBP">GBP (£)</option>
                  <option value="EUR">EUR (€)</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Initial Status</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as 'sent' | 'draft')}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                >
                  <option value="sent">Sent (Active Chase)</option>
                  <option value="draft">Draft</option>
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-slate-400">Summary Description *</label>
              <input
                type="text"
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Q4 Logistics Software License & Support"
                className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-slate-400">Issue Date</label>
                <input
                  type="date"
                  required
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm font-mono text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-400">Due Date *</label>
                <input
                  type="date"
                  required
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-sm font-mono text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                />
              </div>
            </div>
          </section>

          {/* Line Items */}
          <section className="space-y-3 border-t border-slate-800/80 pt-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">Line Items</span>
              <button
                type="button"
                onClick={addLineItem}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/70 px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-slate-100"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Line
              </button>
            </div>

            <div className="space-y-2.5">
              {lineItems.map((item, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 items-center gap-2 rounded-xl border border-slate-800/70 bg-slate-900/40 p-2.5"
                >
                  <input
                    type="text"
                    required
                    value={item.description}
                    onChange={(e) =>
                      updateLineItem(idx, { description: e.target.value })
                    }
                    placeholder="Service or deliverable"
                    className="col-span-6 rounded-lg border border-slate-800 bg-slate-950/70 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
                  />
                  <input
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={item.quantity}
                    onChange={(e) =>
                      updateLineItem(idx, {
                        quantity: Number.parseInt(e.target.value, 10) || 1,
                      })
                    }
                    className="col-span-2 rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-1.5 text-right text-xs font-mono tabular-nums text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                  />
                  <input
                    type="number"
                    min={0.01}
                    step="0.01"
                    required
                    value={item.unit_price}
                    onChange={(e) =>
                      updateLineItem(idx, {
                        unit_price: Number.parseFloat(e.target.value) || 0,
                      })
                    }
                    className="col-span-3 rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-1.5 text-right text-xs font-mono tabular-nums text-slate-100 focus:border-emerald-500/60 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => removeLineItem(idx)}
                    disabled={lineItems.length <= 1}
                    aria-label="Remove line item"
                    className="col-span-1 flex items-center justify-center rounded-lg p-1.5 text-slate-500 hover:text-rose-400 disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between rounded-xl border border-slate-800/80 bg-slate-900/60 px-4 py-3">
              <span className="text-xs font-medium text-slate-400">Invoice Total</span>
              <span className="font-mono text-lg font-bold tabular-nums text-emerald-400">
                {formatCurrency(totalAmount, currency)}
              </span>
            </div>
          </section>

          <div className="flex items-center justify-end gap-3 border-t border-slate-800/80 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800/60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-60"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{submitting ? 'Creating...' : 'Save & Issue Invoice'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
