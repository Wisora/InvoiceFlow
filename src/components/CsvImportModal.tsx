'use client';

import { useState } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { formatCurrency, getTodayIsoDate, parseInvoicesCsv, type ParsedCsvRow } from '@/lib/formatters';
import type { Client } from '@/lib/types';

interface CsvImportModalProps {
  open: boolean;
  organizationId: string;
  existingClients: Client[];
  onClose: () => void;
  onImported: () => Promise<void>;
}

const SAMPLE_CSV = `client_name,client_company,client_email,client_phone,invoice_number,description,amount,currency,due_date,status
Lerato Ndlovu,Highveld Mining Services,lerato@highveldmining.co.za,+27824419902,INV-2026-810,Quarterly Fleet Telemetry,24500.00,ZAR,2026-11-10,overdue
David Van Der Merwe,Table Bay Imports,accounts@tablebay.co.za,+27835512018,INV-2026-811,Customs Clearance API Retainer,14800.00,ZAR,2026-11-28,sent
Amara Okafor,Lagos Express Partners,finance@lagosexpress.ng,+2348031129044,INV-2026-812,Cross-Border Settlement Module,18200.00,ZAR,2026-11-19,sent`;

export default function CsvImportModal({
  open,
  organizationId,
  existingClients,
  onClose,
  onImported,
}: CsvImportModalProps) {
  const [rawCsv, setRawCsv] = useState('');
  const [parsedRows, setParsedRows] = useState<ParsedCsvRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultCount, setResultCount] = useState<number | null>(null);

  if (!open) return null;

  function handleCsvTextChange(text: string) {
    setRawCsv(text);
    setError(null);
    setResultCount(null);
    setParsedRows(parseInvoicesCsv(text));
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      handleCsvTextChange(content);
    };
    reader.readAsText(file);
  }

  function downloadSampleTemplate() {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'invoiceflow-bulk-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleCommitImport() {
    const validRows = parsedRows.filter((r) => r.valid);
    if (validRows.length === 0) {
      setError('No valid rows found to import.');
      return;
    }

    setImporting(true);
    setError(null);

    try {
      // Map existing clients by lowercase email
      const emailToClientId = new Map<string, string>();
      for (const c of existingClients) {
        emailToClientId.set(c.email.trim().toLowerCase(), c.id);
      }

      // Create any missing clients in a single batch
      const missingClientsMap = new Map<
        string,
        {
          organization_id: string;
          name: string;
          company: string | null;
          email: string;
          phone: string | null;
          reliability_label: 'On-Time';
        }
      >();

      for (const row of validRows) {
        const key = row.client_email.trim().toLowerCase();
        if (!emailToClientId.has(key) && !missingClientsMap.has(key)) {
          missingClientsMap.set(key, {
            organization_id: organizationId,
            name: row.client_name,
            company: row.client_company || null,
            email: row.client_email,
            phone: row.client_phone || null,
            reliability_label: 'On-Time',
          });
        }
      }

      if (missingClientsMap.size > 0) {
        const { data: insertedClients, error: cErr } = await supabase
          .from('clients')
          .insert(Array.from(missingClientsMap.values()))
          .select('id, email');

        if (cErr) throw cErr;

        for (const ic of insertedClients ?? []) {
          emailToClientId.set(String(ic.email).trim().toLowerCase(), String(ic.id));
        }
      }

      const todayIso = getTodayIsoDate();
      const invoicesPayload = validRows.map((row) => {
        const clientId = emailToClientId.get(row.client_email.trim().toLowerCase())!;
        const effectiveStatus =
          row.status !== 'draft' && row.due_date < todayIso ? 'overdue' : row.status;

        return {
          organization_id: organizationId,
          client_id: clientId,
          invoice_number: row.invoice_number,
          description: row.description,
          line_items: [
            { description: row.description, quantity: 1, unit_price: row.amount },
          ],
          amount: row.amount,
          currency: row.currency || 'ZAR',
          status: effectiveStatus,
          issue_date: todayIso,
          due_date: row.due_date,
        };
      });

      const { error: invErr } = await supabase.from('invoices').insert(invoicesPayload);
      if (invErr) throw invErr;

      setResultCount(invoicesPayload.length);
      await onImported();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Bulk CSV import failed.';
      setError(msg);
    } finally {
      setImporting(false);
    }
  }

  const validCount = parsedRows.filter((r) => r.valid).length;
  const invalidCount = parsedRows.length - validCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="csv-import-title"
    >
      <div className="glass-panel flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-slate-950/95 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800/80 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
              <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <h2 id="csv-import-title" className="text-base font-semibold text-slate-50">
                CSV Bulk Import
              </h2>
              <p className="text-xs text-slate-400">
                Upload multiple clients and open invoices in one batch
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close CSV import modal"
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800/70 hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800/80 bg-slate-900/50 p-4">
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-semibold text-slate-100 transition-colors hover:bg-slate-700/80">
                <Upload className="h-3.5 w-3.5 text-emerald-400" />
                <span>Choose .CSV File</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
              <button
                type="button"
                onClick={() => handleCsvTextChange(SAMPLE_CSV)}
                className="rounded-xl border border-slate-800 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800/60"
              >
                Load Sample Data
              </button>
            </div>

            <button
              type="button"
              onClick={downloadSampleTemplate}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 hover:text-emerald-300"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download Template</span>
            </button>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              CSV Data (<code className="font-mono">client_name, client_company, client_email, client_phone, invoice_number, description, amount, currency, due_date, status</code>)
            </label>
            <textarea
              rows={5}
              value={rawCsv}
              onChange={(e) => handleCsvTextChange(e.target.value)}
              placeholder="Paste CSV rows here or upload a .csv file above..."
              className="w-full rounded-xl border border-slate-800 bg-slate-900/70 p-3 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
              {error}
            </div>
          )}

          {resultCount !== null && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-200">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>
                Successfully imported <strong>{resultCount}</strong> invoices and synced
                client records.
              </span>
            </div>
          )}

          {parsedRows.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  Preview ({validCount} valid{invalidCount > 0 ? `, ${invalidCount} invalid` : ''})
                </span>
              </div>
              <div className="max-h-56 overflow-auto rounded-xl border border-slate-800/80">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-800 bg-slate-900/90 text-slate-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">Invoice #</th>
                      <th className="px-3 py-2 font-medium">Client</th>
                      <th className="px-3 py-2 font-medium">Due Date</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-3 py-2 font-medium">Validation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 bg-slate-950/60">
                    {parsedRows.map((row, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-2 font-mono text-slate-200">
                          {row.invoice_number}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-200">{row.client_name}</div>
                          <div className="text-[11px] text-slate-500">{row.client_email}</div>
                        </td>
                        <td className="px-3 py-2 font-mono tabular-nums text-slate-300">
                          {row.due_date}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-200">
                          {formatCurrency(row.amount, row.currency)}
                        </td>
                        <td className="px-3 py-2">
                          {row.valid ? (
                            <span className="text-emerald-400">Ready</span>
                          ) : (
                            <span className="text-rose-400">{row.error}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-slate-800/80 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-800 px-4 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800/60"
          >
            Close
          </button>
          <button
            type="button"
            disabled={importing || validCount === 0}
            onClick={handleCommitImport}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>
              {importing
                ? 'Importing...'
                : `Import ${validCount} Invoice${validCount === 1 ? '' : 's'}`}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
