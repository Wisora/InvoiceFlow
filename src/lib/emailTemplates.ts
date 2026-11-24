import { formatCurrency, formatDate } from './formatters';
import type { ReminderTier } from './types';

interface EscalationTemplateInput {
  tier: ReminderTier;
  organizationName: string;
  clientName: string;
  invoiceNumber: string;
  description: string;
  amount: number;
  currency: string;
  dueDate: string;
  daysOverdue: number;
  payUrl: string;
}

export function determineEscalationTier(daysOverdue: number): ReminderTier | null {
  if (daysOverdue >= -3 && daysOverdue <= -1) return 'upcoming';
  if (daysOverdue === 0) return 'due_today';
  if (daysOverdue >= 1 && daysOverdue <= 7) return 'overdue_friendly';
  if (daysOverdue >= 8) return 'overdue_firm';
  return null;
}

export function buildEscalationEmail(input: EscalationTemplateInput): {
  subject: string;
  html: string;
  text: string;
} {
  const amountFormatted = formatCurrency(input.amount, input.currency);
  const dueFormatted = formatDate(input.dueDate);

  let subject = '';
  let badgeText = '';
  let badgeBg = '#1e293b';
  let badgeColor = '#cbd5e1';
  let intro = '';
  let closing = '';

  switch (input.tier) {
    case 'upcoming': {
      const daysLeft = Math.abs(input.daysOverdue);
      subject = `Upcoming Invoice ${input.invoiceNumber} (${amountFormatted}) — Due ${dueFormatted}`;
      badgeText = `Due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
      badgeBg = '#0f172a';
      badgeColor = '#38bdf8';
      intro = `This is a courtesy heads-up from ${input.organizationName} that invoice ${input.invoiceNumber} for ${input.description} is scheduled for payment on ${dueFormatted}.`;
      closing = `If you already have this queued for payment, no action is needed. Otherwise, you can settle online or submit a scheduled payment date directly from the portal.`;
      break;
    }
    case 'due_today': {
      subject = `Payment Due Today: Invoice ${input.invoiceNumber} (${amountFormatted})`;
      badgeText = 'Due Today';
      badgeBg = '#451a03';
      badgeColor = '#fbbf24';
      intro = `Invoice ${input.invoiceNumber} (${input.description}) from ${input.organizationName} is due today, ${dueFormatted}.`;
      closing = `Use the secure payment link below to settle immediately via card, EFT, or instant Paystack checkout.`;
      break;
    }
    case 'overdue_friendly': {
      subject = `Gentle Follow-Up: Invoice ${input.invoiceNumber} is ${input.daysOverdue} day${input.daysOverdue === 1 ? '' : 's'} overdue`;
      badgeText = `${input.daysOverdue}d Overdue`;
      badgeBg = '#451a03';
      badgeColor = '#f59e0b';
      intro = `We hope your week is going well. Our records indicate invoice ${input.invoiceNumber} for ${amountFormatted} passed its due date of ${dueFormatted} (${input.daysOverdue} day${input.daysOverdue === 1 ? '' : 's'} ago).`;
      closing = `If payment has already been dispatched, or if you need to propose a new settlement date or flag an issue, please update us via the portal link below.`;
      break;
    }
    case 'overdue_firm': {
      subject = `Action Required: Invoice ${input.invoiceNumber} (${amountFormatted}) is ${input.daysOverdue} days past due`;
      badgeText = `${input.daysOverdue}d Past Due — Action Required`;
      badgeBg = '#450a0a';
      badgeColor = '#f87171';
      intro = `Invoice ${input.invoiceNumber} from ${input.organizationName} for ${amountFormatted} is now ${input.daysOverdue} days past its due date of ${dueFormatted} and requires immediate attention.`;
      closing = `Please settle the outstanding balance today using the secure portal below, or register a confirmed Promise to Pay date / dispute note so our accounts team can update your account.`;
      break;
    }
    case 'manual':
    default: {
      subject = `Invoice ${input.invoiceNumber} from ${input.organizationName} (${amountFormatted})`;
      badgeText =
        input.daysOverdue > 0
          ? `${input.daysOverdue}d Overdue`
          : `Due ${dueFormatted}`;
      badgeBg = input.daysOverdue > 0 ? '#450a0a' : '#0f172a';
      badgeColor = input.daysOverdue > 0 ? '#f87171' : '#34d399';
      intro = `${input.organizationName} sent you a reminder for invoice ${input.invoiceNumber} (${input.description}) totaling ${amountFormatted}, due ${dueFormatted}.`;
      closing = `Click below to review the invoice breakdown, pay securely online, or let our team know when payment is scheduled.`;
      break;
    }
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:32px 16px;background-color:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e2e8f0;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background-color:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden;">
    <tr>
      <td style="padding:28px 32px;border-bottom:1px solid #1e293b;">
        <div style="font-size:13px;font-weight:600;color:#94a3b8;letter-spacing:0.04em;">${escapeHtml(input.organizationName)} via InvoiceFlow</div>
        <h1 style="margin:10px 0 0;font-size:22px;font-weight:700;color:#f8fafc;">Invoice ${escapeHtml(input.invoiceNumber)}</h1>
        <div style="margin-top:12px;display:inline-block;padding:4px 10px;border-radius:6px;background-color:${badgeBg};color:${badgeColor};font-size:12px;font-weight:600;">
          ${escapeHtml(badgeText)}
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:28px 32px;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#cbd5e1;">Hi ${escapeHtml(input.clientName)},</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#cbd5e1;">${escapeHtml(intro)}</p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#020617;border:1px solid #1e293b;border-radius:8px;margin-bottom:24px;">
          <tr>
            <td style="padding:14px 16px;font-size:13px;color:#94a3b8;">Amount Due</td>
            <td style="padding:14px 16px;font-size:16px;font-weight:700;color:#f8fafc;text-align:right;font-family:monospace;">${escapeHtml(amountFormatted)}</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;border-top:1px solid #1e293b;font-size:13px;color:#94a3b8;">Due Date</td>
            <td style="padding:10px 16px;border-top:1px solid #1e293b;font-size:13px;color:#e2e8f0;text-align:right;font-family:monospace;">${escapeHtml(dueFormatted)}</td>
          </tr>
          <tr>
            <td style="padding:10px 16px;border-top:1px solid #1e293b;font-size:13px;color:#94a3b8;">Description</td>
            <td style="padding:10px 16px;border-top:1px solid #1e293b;font-size:13px;color:#e2e8f0;text-align:right;">${escapeHtml(input.description)}</td>
          </tr>
        </table>
        <div style="text-align:center;margin:28px 0;">
          <a href="${escapeHtml(input.payUrl)}" style="display:inline-block;padding:13px 28px;background-color:#10b981;color:#020617;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;">
            Review &amp; Pay ${escapeHtml(amountFormatted)}
          </a>
        </div>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#94a3b8;">${escapeHtml(closing)}</p>
      </td>
    </tr>
    <tr>
      <td style="padding:18px 32px;background-color:#020617;border-top:1px solid #1e293b;font-size:12px;color:#64748b;">
        Need to schedule a later payment or flag a discrepancy? Open the payment portal link above to notify ${escapeHtml(input.organizationName)} directly.
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  const text = [
    `Hi ${input.clientName},`,
    '',
    intro,
    '',
    `Invoice: ${input.invoiceNumber}`,
    `Amount Due: ${amountFormatted}`,
    `Due Date: ${dueFormatted}`,
    `Description: ${input.description}`,
    '',
    `Pay or update status online: ${input.payUrl}`,
    '',
    closing,
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
