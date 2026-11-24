import type { Invoice, ReliabilityLabel } from './types';

export function formatCurrency(amount: number, currency = 'ZAR'): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const code = (currency || 'ZAR').toUpperCase();
  try {
    return new Intl.NumberFormat('en-ZA', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  } catch {
    return `${code} ${safeAmount.toFixed(2)}`;
  }
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const parsed = new Date(dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return dateStr;
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
}

export function getTodayIsoDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDaysOverdue(dueDateStr: string, referenceDate?: Date): number {
  const today = referenceDate ? new Date(referenceDate) : new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const due = new Date(dueDateStr.includes('T') ? dueDateStr : `${dueDateStr}T00:00:00`);
  const dueMidnight = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffMs = todayMidnight.getTime() - dueMidnight.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

export function getEffectiveInvoiceStatus(invoice: Invoice): Invoice['status'] {
  if (invoice.status === 'paid' || invoice.status === 'cancelled' || invoice.status === 'draft') {
    return invoice.status;
  }
  const overdueDays = getDaysOverdue(invoice.due_date);
  if (overdueDays > 0) {
    return 'overdue';
  }
  return invoice.status;
}

export function computeClientReliability(clientInvoices: Invoice[]): ReliabilityLabel {
  let severeLateCount = 0;
  let lateCount = 0;

  for (const inv of clientInvoices) {
    if (inv.status === 'cancelled' || inv.status === 'draft') continue;

    if (inv.status === 'paid' && inv.paid_at) {
      const paidDate = new Date(inv.paid_at);
      const diffFromDue = getDaysOverdue(inv.due_date, paidDate);
      if (diffFromDue > 14) {
        severeLateCount += 1;
        lateCount += 1;
      } else if (diffFromDue > 0) {
        lateCount += 1;
      }
    } else if (inv.status === 'sent' || inv.status === 'overdue') {
      const overdueDays = getDaysOverdue(inv.due_date);
      if (overdueDays > 14) {
        severeLateCount += 1;
        lateCount += 1;
      } else if (overdueDays > 0) {
        lateCount += 1;
      }
    }
  }

  if (severeLateCount >= 1 || lateCount >= 2) return 'At Risk';
  if (lateCount === 1) return 'Slow Payer';
  return 'On-Time';
}

export function sanitizeWhatsAppPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  } else if (digits.startsWith('0') && digits.length === 10) {
    // Convert local SA 082... to 2782...
    digits = `27${digits.slice(1)}`;
  }
  return digits.length >= 8 ? digits : null;
}

export function buildWhatsAppChaseUrl(params: {
  phone: string | null | undefined;
  clientName: string;
  organizationName: string;
  invoiceNumber: string;
  amountFormatted: string;
  dueDate: string;
  payUrl: string;
}): string | null {
  const cleanPhone = sanitizeWhatsAppPhone(params.phone);
  if (!cleanPhone) return null;

  const days = getDaysOverdue(params.dueDate);
  const urgencyLine =
    days > 0
      ? `which is now ${days} day${days === 1 ? '' : 's'} past its due date (${formatDate(params.dueDate)}).`
      : `due on ${formatDate(params.dueDate)}.`;

  const message = [
    `Hi ${params.clientName},`,
    ``,
    `Friendly reminder from ${params.organizationName} regarding Invoice ${params.invoiceNumber} for ${params.amountFormatted}, ${urgencyLine}`,
    ``,
    `You can view the breakdown and settle securely online here:`,
    params.payUrl,
    ``,
    `Thank you!`,
  ].join('\n');

  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
}

export interface ParsedCsvRow {
  client_name: string;
  client_company: string;
  client_email: string;
  client_phone: string;
  invoice_number: string;
  description: string;
  amount: number;
  currency: string;
  due_date: string;
  status: 'draft' | 'sent' | 'overdue';
  valid: boolean;
  error?: string;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

export function parseInvoicesCsv(rawCsv: string): ParsedCsvRow[] {
  const lines = rawCsv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));

  const idx = (name: string, alt?: string): number => {
    const first = headers.indexOf(name);
    if (first !== -1) return first;
    return alt ? headers.indexOf(alt) : -1;
  };

  const cNameIdx = idx('client_name', 'name');
  const cCompanyIdx = idx('client_company', 'company');
  const cEmailIdx = idx('client_email', 'email');
  const cPhoneIdx = idx('client_phone', 'phone');
  const invNumIdx = idx('invoice_number', 'invoice_no');
  const descIdx = idx('description');
  const amtIdx = idx('amount');
  const curIdx = idx('currency');
  const dueIdx = idx('due_date');
  const statusIdx = idx('status');

  return lines.slice(1).map((line, i) => {
    const cols = splitCsvLine(line);
    const client_name = cNameIdx >= 0 ? cols[cNameIdx] ?? '' : '';
    const client_company = cCompanyIdx >= 0 ? cols[cCompanyIdx] ?? '' : '';
    const client_email = cEmailIdx >= 0 ? cols[cEmailIdx] ?? '' : '';
    const client_phone = cPhoneIdx >= 0 ? cols[cPhoneIdx] ?? '' : '';
    const invoice_number =
      invNumIdx >= 0 && cols[invNumIdx] ? cols[invNumIdx] : `INV-CSV-${1001 + i}`;
    const description = descIdx >= 0 && cols[descIdx] ? cols[descIdx] : 'Services Rendered';
    const rawAmt = amtIdx >= 0 ? cols[amtIdx]?.replace(/[^0-9.-]/g, '') ?? '0' : '0';
    const amount = Number.parseFloat(rawAmt);
    const currency = curIdx >= 0 && cols[curIdx] ? cols[curIdx].toUpperCase() : 'ZAR';
    const due_date = dueIdx >= 0 && cols[dueIdx] ? cols[dueIdx] : getTodayIsoDate();
    const rawStatus = statusIdx >= 0 ? (cols[statusIdx] ?? 'sent').toLowerCase() : 'sent';
    const status: 'draft' | 'sent' | 'overdue' =
      rawStatus === 'draft' || rawStatus === 'overdue' ? rawStatus : 'sent';

    const errors: string[] = [];
    if (!client_name) errors.push('Missing client_name');
    if (!client_email || !client_email.includes('@')) errors.push('Invalid client_email');
    if (!Number.isFinite(amount) || amount <= 0) errors.push('Invalid amount');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due_date)) errors.push('Due date must be YYYY-MM-DD');

    return {
      client_name,
      client_company,
      client_email,
      client_phone,
      invoice_number,
      description,
      amount: Number.isFinite(amount) ? amount : 0,
      currency,
      due_date,
      status,
      valid: errors.length === 0,
      error: errors.length > 0 ? errors.join(', ') : undefined,
    };
  });
}
