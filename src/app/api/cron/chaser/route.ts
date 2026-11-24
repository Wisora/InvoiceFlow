import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { getDaysOverdue, getTodayIsoDate } from '@/lib/formatters';
import { buildEscalationEmail, determineEscalationTier } from '@/lib/emailTemplates';

export const dynamic = 'force-dynamic';

interface JoinedInvoiceRow {
  id: string;
  organization_id: string;
  client_id: string;
  invoice_number: string;
  description: string;
  amount: number;
  currency: string;
  status: string;
  due_date: string;
  promised_pay_date: string | null;
  dispute_note: string | null;
  last_reminded_at: string | null;
  client: {
    id: string;
    name: string;
    email: string;
  } | null;
  organization: {
    id: string;
    name: string;
    owner_id: string;
  } | null;
}

export async function GET(request: NextRequest) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = request.headers.get('authorization');
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;

    let scopedOwnerId: string | null = null;

    // Authorize either via CRON_SECRET or an authenticated Supabase user JWT (for manual dashboard trigger)
    if (cronSecret && bearerToken === cronSecret) {
      scopedOwnerId = null;
    } else if (bearerToken) {
      const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(bearerToken);
      if (userErr || !userData.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      scopedOwnerId = userData.user.id;
    } else {
      return NextResponse.json({ error: 'Unauthorized cron invocation' }, { status: 401 });
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey || resendApiKey.includes('your_resend_api_key')) {
      return NextResponse.json(
        { error: 'RESEND_API_KEY is not configured on the server.' },
        { status: 500 }
      );
    }

    const resend = new Resend(resendApiKey);
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'InvoiceFlow <onboarding@resend.dev>';
    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL ||
      request.nextUrl.origin ||
      'http://localhost:3000'
    ).replace(/\/$/, '');

    const todayIso = getTodayIsoDate();
    const cooldownCutoffMs = Date.now() - 20 * 60 * 60 * 1000; // 20 hours

    const { data: rawInvoices, error: fetchError } = await supabaseAdmin
      .from('invoices')
      .select(
        `
        id,
        organization_id,
        client_id,
        invoice_number,
        description,
        amount,
        currency,
        status,
        due_date,
        promised_pay_date,
        dispute_note,
        last_reminded_at,
        client:clients(id, name, email),
        organization:organizations(id, name, owner_id)
      `
      )
      .in('status', ['sent', 'overdue']);

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    const invoices = ((rawInvoices ?? []) as unknown as JoinedInvoiceRow[]).filter((inv) =>
      scopedOwnerId ? inv.organization?.owner_id === scopedOwnerId : true
    );

    const summary = {
      processed: invoices.length,
      sent: 0,
      marked_overdue: 0,
      skipped_disputed: 0,
      skipped_promised: 0,
      skipped_recent: 0,
      skipped_not_due: 0,
      errors: [] as Array<{ invoice_id: string; message: string }>,
    };

    for (const inv of invoices) {
      // Skip invoices with an active dispute note before changing status or sending reminders
      if (inv.dispute_note && inv.dispute_note.trim().length > 0) {
        summary.skipped_disputed += 1;
        continue;
      }

      // Skip invoices with a promised pay date today or in the future
      if (inv.promised_pay_date && inv.promised_pay_date >= todayIso) {
        summary.skipped_promised += 1;
        continue;
      }

      const daysOverdue = getDaysOverdue(inv.due_date);

      // Automatically promote past-due 'sent' invoices to 'overdue'
      if (daysOverdue > 0 && inv.status === 'sent') {
        const { error: overdueErr } = await supabaseAdmin
          .from('invoices')
          .update({ status: 'overdue' })
          .eq('id', inv.id);

        if (!overdueErr) {
          summary.marked_overdue += 1;
        }
      }

      // Prevent duplicate emails within 20 hours
      if (inv.last_reminded_at && new Date(inv.last_reminded_at).getTime() > cooldownCutoffMs) {
        summary.skipped_recent += 1;
        continue;
      }

      const tier = determineEscalationTier(daysOverdue);
      if (!tier) {
        summary.skipped_not_due += 1;
        continue;
      }

      if (!inv.client?.email) {
        summary.errors.push({
          invoice_id: inv.id,
          message: 'Client email missing.',
        });
        continue;
      }

      const payUrl = `${appUrl}/pay/${inv.id}`;
      const emailPayload = buildEscalationEmail({
        tier,
        organizationName: inv.organization?.name || 'InvoiceFlow Vendor',
        clientName: inv.client.name || 'Valued Client',
        invoiceNumber: inv.invoice_number,
        description: inv.description,
        amount: Number(inv.amount),
        currency: inv.currency || 'ZAR',
        dueDate: inv.due_date,
        daysOverdue,
        payUrl,
      });

      const { data: sendResult, error: sendError } = await resend.emails.send({
        from: fromEmail,
        to: [inv.client.email],
        subject: emailPayload.subject,
        html: emailPayload.html,
        text: emailPayload.text,
      });

      if (sendError) {
        summary.errors.push({
          invoice_id: inv.id,
          message: sendError.message,
        });
        continue;
      }

      const nowIso = new Date().toISOString();

      await supabaseAdmin.from('reminder_logs').insert({
        organization_id: inv.organization_id,
        invoice_id: inv.id,
        channel: 'email',
        template_tier: tier,
        recipient: inv.client.email,
        subject: emailPayload.subject,
        provider_message_id: sendResult?.id ?? null,
        status: 'sent',
        sent_at: nowIso,
      });

      await supabaseAdmin
        .from('invoices')
        .update({ last_reminded_at: nowIso })
        .eq('id', inv.id);

      summary.sent += 1;
    }

    return NextResponse.json({
      ok: true,
      ran_at: new Date().toISOString(),
      ...summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Cron execution failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}