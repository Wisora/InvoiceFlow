import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { getDaysOverdue } from '@/lib/formatters';
import { buildEscalationEmail, determineEscalationTier } from '@/lib/emailTemplates';

export const dynamic = 'force-dynamic';

interface RemindRequestBody {
  invoiceId?: string;
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) {
      return NextResponse.json({ error: 'Missing authorization token.' }, { status: 401 });
    }

    const body = (await request.json()) as RemindRequestBody;
    if (!body.invoiceId) {
      return NextResponse.json({ error: 'invoiceId is required.' }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData.user) {
      return NextResponse.json({ error: 'Invalid session token.' }, { status: 401 });
    }

    const { data: invoice, error: invError } = await supabaseAdmin
      .from('invoices')
      .select(
        `
        id,
        organization_id,
        invoice_number,
        description,
        amount,
        currency,
        status,
        due_date,
        client:clients(id, name, email),
        organization:organizations(id, name, owner_id)
      `
      )
      .eq('id', body.invoiceId)
      .maybeSingle();

    if (invError) {
      return NextResponse.json({ error: invError.message }, { status: 500 });
    }

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
    }

    const org = invoice.organization as unknown as {
      id: string;
      name: string;
      owner_id: string;
    } | null;

    const client = invoice.client as unknown as {
      id: string;
      name: string;
      email: string;
    } | null;

    if (!org || org.owner_id !== userData.user.id) {
      return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
    }

    if (!client?.email) {
      return NextResponse.json(
        { error: 'Client does not have a valid email address.' },
        { status: 400 }
      );
    }

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey || resendApiKey.includes('your_resend_api_key')) {
      return NextResponse.json(
        { error: 'RESEND_API_KEY is not configured in environment variables.' },
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

    const daysOverdue = getDaysOverdue(invoice.due_date);
    const tier = determineEscalationTier(daysOverdue) ?? 'manual';
    const payUrl = `${appUrl}/pay/${invoice.id}`;

    const emailContent = buildEscalationEmail({
      tier,
      organizationName: org.name,
      clientName: client.name,
      invoiceNumber: invoice.invoice_number,
      description: invoice.description,
      amount: Number(invoice.amount),
      currency: invoice.currency || 'ZAR',
      dueDate: invoice.due_date,
      daysOverdue,
      payUrl,
    });

    const { data: sendResult, error: sendError } = await resend.emails.send({
      from: fromEmail,
      to: [client.email],
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    if (sendError) {
      return NextResponse.json({ error: sendError.message }, { status: 502 });
    }

    const nowIso = new Date().toISOString();

    await supabaseAdmin.from('reminder_logs').insert({
      organization_id: invoice.organization_id,
      invoice_id: invoice.id,
      channel: 'email',
      template_tier: 'manual',
      recipient: client.email,
      subject: emailContent.subject,
      provider_message_id: sendResult?.id ?? null,
      status: 'sent',
      sent_at: nowIso,
    });

    // If invoice was draft, promote to sent on manual reminder
    const nextStatus =
      invoice.status === 'draft'
        ? daysOverdue > 0
          ? 'overdue'
          : 'sent'
        : invoice.status;

    await supabaseAdmin
      .from('invoices')
      .update({
        last_reminded_at: nowIso,
        status: nextStatus,
      })
      .eq('id', invoice.id);

    return NextResponse.json({
      ok: true,
      messageId: sendResult?.id ?? null,
      sentAt: nowIso,
      status: nextStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send reminder.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
