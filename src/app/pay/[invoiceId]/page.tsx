'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  Flag,
  Loader2,
  Lock,
  Receipt,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  formatCurrency,
  formatDate,
  getDaysOverdue,
  getTodayIsoDate,
} from '@/lib/formatters';
import type { Invoice, LineItem } from '@/lib/types';

export default function PublicInvoicePayPage() {
  const params = useParams<{ invoiceId: string }>();
  const invoiceId = params?.invoiceId;

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Paystack state
  const [paying, setPaying] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);

  // Promise to pay later
  const [promiseDate, setPromiseDate] = useState('');
  const [savingPromise, setSavingPromise] = useState(false);
  const [promiseSavedMsg, setPromiseSavedMsg] = useState<string | null>(null);

  // Report an issue modal
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [disputeNote, setDisputeNote] = useState('');
  const [savingDispute, setSavingDispute] = useState(false);
  const [disputeSavedMsg, setDisputeSavedMsg] = useState<string | null>(null);

  const loadInvoice = useCallback(async () => {
    if (!invoiceId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(invoiceId)}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as { invoice?: Invoice; error?: string };

      if (!res.ok || !json.invoice) {
        setError(json.error || 'Invoice not found.');
        return;
      }

      setInvoice(json.invoice);
      if (json.invoice.promised_pay_date) {
        setPromiseDate(json.invoice.promised_pay_date);
      }
      if (json.invoice.dispute_note) {
        setDisputeNote(json.invoice.dispute_note);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load invoice.');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    loadInvoice();
  }, [loadInvoice]);

  useEffect(() => {
    if (!showIssueModal) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setShowIssueModal(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showIssueModal]);

  async function handlePayNow() {
    if (!invoice) return;

    const publicKey = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY;
    if (!publicKey || publicKey.includes('your_paystack_public_key')) {
      setError(
        'NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY is not configured. Add your Paystack public key to enable live checkout.'
      );
      return;
    }

    setError(null);
    setPaymentMessage(null);
    setPaying(true);

    const resetTimer = window.setTimeout(() => {
      setPaying(false);
    }, 60000);

    try {
      // Dynamic client-side import guarantees @paystack/inline-js never runs during Next.js SSR
      const PaystackPop = (await import('@paystack/inline-js')).default;
      const paystack = new PaystackPop();

      const reference = `IF-${invoice.invoice_number.replace(/[^a-zA-Z0-9.-]/g, '')}-${Date.now()}`;
      const amountInMinorUnits = Math.round(Number(invoice.amount) * 100);

      paystack.newTransaction({
        key: publicKey,
        email: invoice.client?.email || 'billing@invoiceflow.app',
        amount: amountInMinorUnits,
        currency: (invoice.currency || 'ZAR').toUpperCase(),
        reference,
        metadata: {
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          custom_fields: [
            {
              display_name: 'Invoice Number',
              variable_name: 'invoice_number',
              value: invoice.invoice_number,
            },
          ],
        },
        onSuccess: async (transaction) => {
          window.clearTimeout(resetTimer);
          try {
            const confirmRes = await fetch(
              `/api/pay/${encodeURIComponent(invoice.id)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'confirm_payment',
                  reference: transaction.reference || reference,
                }),
              }
            );
            const confirmJson = (await confirmRes.json()) as {
              ok?: boolean;
              error?: string;
            };
            if (!confirmRes.ok) {
              setError(
                confirmJson.error ||
                  'Payment captured by Paystack; webhook reconciliation is pending.'
              );
            } else {
              setPaymentMessage(
                `Payment confirmed (Ref: ${transaction.reference || reference}).`
              );
              await loadInvoice();
            }
          } finally {
            setPaying(false);
          }
        },
        onCancel: () => {
          window.clearTimeout(resetTimer);
          setPaying(false);
        },
        onError: (err) => {
          window.clearTimeout(resetTimer);
          setError(err.message || 'Paystack checkout encountered an error.');
          setPaying(false);
        },
      });
    } catch (err) {
      window.clearTimeout(resetTimer);
      setError(
        err instanceof Error ? err.message : 'Unable to initialize Paystack checkout.'
      );
      setPaying(false);
    }
  }

  async function handlePromiseSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!invoice || !promiseDate) return;

    setSavingPromise(true);
    setPromiseSavedMsg(null);
    setError(null);

    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(invoice.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'promise_to_pay',
          promised_pay_date: promiseDate,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok) {
        setError(json.error || 'Could not save payment commitment.');
        return;
      }

      setPromiseSavedMsg(
        `Confirmed. Automated reminders are paused until ${formatDate(promiseDate)}.`
      );
      await loadInvoice();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setSavingPromise(false);
    }
  }

  async function handleIssueSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!invoice || !disputeNote.trim()) return;

    setSavingDispute(true);
    setDisputeSavedMsg(null);
    setError(null);

    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(invoice.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'report_issue',
          dispute_note: disputeNote.trim(),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok) {
        setError(json.error || 'Could not submit issue report.');
        return;
      }

      setDisputeSavedMsg(
        'Issue logged and flagged for the billing team. Automated reminders are paused.'
      );
      setShowIssueModal(false);
      await loadInvoice();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.');
    } finally {
      setSavingDispute(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="glass-panel flex items-center gap-3 rounded-xl px-5 py-4 text-sm text-slate-300">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          <span>Loading invoice breakdown...</span>
        </div>
      </main>
    );
  }

  if (!invoice) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="glass-panel max-w-md rounded-2xl p-8 text-center">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-400" />
          <h1 className="text-lg font-semibold text-slate-100">Invoice Unavailable</h1>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            {error || 'This payment link is invalid or the invoice could not be retrieved.'}
          </p>
        </div>
      </main>
    );
  }

  const lineItems: LineItem[] =
    Array.isArray(invoice.line_items) && invoice.line_items.length > 0
      ? invoice.line_items
      : [
          {
            description: invoice.description,
            quantity: 1,
            unit_price: Number(invoice.amount),
          },
        ];

  const isPaid = invoice.status === 'paid';
  const isCancelled = invoice.status === 'cancelled';
  const daysOver = getDaysOverdue(invoice.due_date);

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5 text-sm font-semibold text-slate-200">
          <Receipt className="h-4 w-4 text-emerald-400" />
          <span>{invoice.organization?.name || 'InvoiceFlow Billing'}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <Lock className="h-3.5 w-3.5 text-emerald-400" />
          <span>Secured Paystack Portal</span>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <span>{error}</span>
        </div>
      )}

      {paymentMessage && (
        <div className="mb-5 flex items-center gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <span>{paymentMessage}</span>
        </div>
      )}

      {promiseSavedMsg && (
        <div className="mb-5 flex items-center gap-2.5 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs text-sky-200">
          <CalendarClock className="h-4 w-4 text-sky-400" />
          <span>{promiseSavedMsg}</span>
        </div>
      )}

      {disputeSavedMsg && (
        <div className="mb-5 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
          <Flag className="mt-0.5 h-4 w-4 text-amber-400" />
          <span>{disputeSavedMsg}</span>
        </div>
      )}

      <article className="glass-panel overflow-hidden rounded-2xl shadow-2xl shadow-black/40">
        {/* Invoice Header */}
        <div className="flex flex-col justify-between gap-4 border-b border-slate-800/80 px-6 py-6 sm:flex-row sm:items-start">
          <div>
            <p className="text-xs font-medium text-slate-400">Invoice Reference</p>
            <h1 className="mt-1 font-mono text-2xl font-bold text-slate-50">
              {invoice.invoice_number}
            </h1>
            <p className="mt-1 text-sm text-slate-300">{invoice.description}</p>
          </div>

          <div className="text-left sm:text-right">
            <p className="text-xs font-medium text-slate-400">
              {isPaid ? 'Amount Settled' : 'Balance Due'}
            </p>
            <div className="mt-1 font-mono text-3xl font-bold tabular-nums text-slate-50">
              {formatCurrency(Number(invoice.amount), invoice.currency)}
            </div>
            <div className="mt-1.5 text-xs">
              {isPaid ? (
                <span className="inline-flex items-center gap-1 font-semibold text-emerald-400">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Paid on {formatDate(invoice.paid_at)}
                </span>
              ) : isCancelled ? (
                <span className="font-semibold text-slate-400">Cancelled</span>
              ) : daysOver > 0 ? (
                <span className="font-mono font-semibold text-rose-400 tabular-nums">
                  Overdue by {daysOver} day{daysOver === 1 ? '' : 's'} (Due{' '}
                  {formatDate(invoice.due_date)})
                </span>
              ) : (
                <span className="font-mono text-slate-300 tabular-nums">
                  Due {formatDate(invoice.due_date)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Billing Parties */}
        <div className="grid grid-cols-1 gap-4 border-b border-slate-800/80 bg-slate-950/40 px-6 py-5 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-slate-500">Billed From</p>
            <p className="mt-1 text-sm font-semibold text-slate-100">
              {invoice.organization?.name || 'Vendor'}
            </p>
            {invoice.organization?.contact_email && (
              <p className="text-xs text-slate-400">
                {invoice.organization.contact_email}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Billed To</p>
            <p className="mt-1 text-sm font-semibold text-slate-100">
              {invoice.client?.name}
              {invoice.client?.company ? ` — ${invoice.client.company}` : ''}
            </p>
            <p className="text-xs text-slate-400">{invoice.client?.email}</p>
            <p className="mt-1 font-mono text-[11px] text-slate-500 tabular-nums">
              Issued {formatDate(invoice.issue_date)}
            </p>
          </div>
        </div>

        {/* Line Items Breakdown */}
        <div className="px-6 py-5">
          <h2 className="mb-3 text-xs font-semibold text-slate-400">
            Itemized Breakdown
          </h2>
          <div className="overflow-hidden rounded-xl border border-slate-800/80">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800/80 bg-slate-950/60 text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Item</th>
                  <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-4 py-2.5 text-right font-medium">Unit Price</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {lineItems.map((item, idx) => (
                  <tr key={idx}>
                    <td className="px-4 py-3 text-slate-200">{item.description}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-300">
                      {item.quantity}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-300">
                      {formatCurrency(Number(item.unit_price), invoice.currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-slate-100">
                      {formatCurrency(
                        Number(item.quantity) * Number(item.unit_price),
                        invoice.currency
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-800 bg-slate-950/70">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-right font-semibold text-slate-300">
                    Total ({invoice.currency})
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-sm font-bold tabular-nums text-emerald-400">
                    {formatCurrency(Number(invoice.amount), invoice.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Active Promise / Dispute Status Callouts */}
        {!isPaid && (invoice.promised_pay_date || invoice.dispute_note) && (
          <div className="space-y-2 border-t border-slate-800/80 bg-slate-950/30 px-6 py-4 text-xs">
            {invoice.promised_pay_date && (
              <div className="flex items-center gap-2 text-sky-300">
                <CalendarClock className="h-4 w-4 shrink-0" />
                <span>
                  Scheduled Promise to Pay:{' '}
                  <strong className="font-mono">
                    {formatDate(invoice.promised_pay_date)}
                  </strong>{' '}
                  (automated chasers paused)
                </span>
              </div>
            )}
            {invoice.dispute_note && (
              <div className="flex items-start gap-2 text-amber-300">
                <Flag className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Flagged Issue: <em>{invoice.dispute_note}</em>
                </span>
              </div>
            )}
          </div>
        )}

        {/* Action Section */}
        <div className="border-t border-slate-800/80 bg-slate-950/60 px-6 py-6">
          {isPaid ? (
            <div className="flex flex-col items-center justify-between gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5 sm:flex-row">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-6 w-6 text-emerald-400" />
                <div>
                  <p className="text-sm font-semibold text-emerald-100">
                    Invoice Paid in Full
                  </p>
                  <p className="font-mono text-xs text-emerald-300/80">
                    Reference: {invoice.paystack_reference || 'Recorded Offline'}
                  </p>
                </div>
              </div>
              <span className="font-mono text-xs text-emerald-200 tabular-nums">
                {formatDate(invoice.paid_at)}
              </span>
            </div>
          ) : isCancelled ? (
            <p className="text-center text-xs text-slate-400">
              This invoice has been cancelled by {invoice.organization?.name}.
            </p>
          ) : (
            <div className="space-y-5">
              {/* Primary CTA: Paystack Checkout */}
              <button
                type="button"
                disabled={paying}
                onClick={handlePayNow}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-emerald-500 px-6 py-3.5 text-sm font-bold text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {paying ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CreditCard className="h-4 w-4" />
                )}
                <span>
                  {paying
                    ? 'Launching Paystack Checkout...'
                    : `Pay Now · ${formatCurrency(Number(invoice.amount), invoice.currency)}`}
                </span>
              </button>

              {/* Secondary Workflows: Promise to Pay Later & Report an Issue */}
              <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <form
                  onSubmit={handlePromiseSubmit}
                  className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
                >
                  <label
                    htmlFor="promise-date"
                    className="flex items-center gap-1.5 text-xs font-semibold text-slate-200"
                  >
                    <CalendarClock className="h-3.5 w-3.5 text-sky-400" />
                    <span>Promise to Pay Later</span>
                  </label>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Commit a scheduled payment date to pause automated reminders.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <input
                      id="promise-date"
                      type="date"
                      min={getTodayIsoDate()}
                      required
                      value={promiseDate}
                      onChange={(e) => setPromiseDate(e.target.value)}
                      className="w-full rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-sky-500/60 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={savingPromise || !promiseDate}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
                    >
                      {savingPromise ? 'Saving...' : 'Commit'}
                    </button>
                  </div>
                </form>

                <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                  <div>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                      <Flag className="h-3.5 w-3.5 text-amber-400" />
                      <span>Discrepancy or PO Question?</span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400">
                      Notify {invoice.organization?.name} directly and pause reminders while
                      reviewed.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowIssueModal(true)}
                    className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700"
                  >
                    Report an Issue
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </article>

      {/* Report an Issue Modal */}
      {showIssueModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-issue-title"
        >
          <div className="glass-panel w-full max-w-md rounded-2xl bg-slate-950/95 p-6 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 id="report-issue-title" className="text-base font-semibold text-slate-50">
                Report an Invoice Issue
              </h2>
              <button
                type="button"
                onClick={() => setShowIssueModal(false)}
                aria-label="Close issue modal"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Your note will be surfaced to {invoice.organization?.name} and automated email
              chasers will be paused.
            </p>
            <form onSubmit={handleIssueSubmit} className="mt-4 space-y-4">
              <textarea
                rows={4}
                required
                minLength={5}
                value={disputeNote}
                onChange={(e) => setDisputeNote(e.target.value)}
                placeholder="Example: Purchase order #PO-4491 is missing from line item 2, or VAT registration number needs updating."
                className="w-full rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-100 placeholder:text-slate-600 focus:border-amber-500/60 focus:outline-none"
              />
              <div className="flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowIssueModal(false)}
                  className="rounded-xl border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800/60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingDispute}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-60"
                >
                  {savingDispute && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>Submit Issue</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}