import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { formatCurrency } from '@/lib/formatters';

export const dynamic = 'force-dynamic';

interface PaystackCustomField {
  variable_name?: string;
  value?: string;
}

interface PaystackWebhookPayload {
  event?: string;
  data?: {
    reference?: string;
    paid_at?: string;
    amount?: number;
    currency?: string;
    metadata?: {
      invoice_id?: string;
      invoice_number?: string;
      custom_fields?: PaystackCustomField[];
    };
  };
}

function extractInvoiceId(payload: PaystackWebhookPayload): string | undefined {
  const direct = payload.data?.metadata?.invoice_id?.trim();
  if (direct) return direct;

  const customFields = payload.data?.metadata?.custom_fields;
  if (Array.isArray(customFields)) {
    const match = customFields.find(
      (field) => field.variable_name === 'invoice_id' && field.value?.trim()
    );
    if (match?.value) return match.value.trim();
  }

  return undefined;
}

export async function POST(request: NextRequest) {
  try {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey || secretKey.includes('your_paystack_secret_key')) {
      return NextResponse.json(
        { error: 'PAYSTACK_SECRET_KEY is not configured.' },
        { status: 500 }
      );
    }

    const signature = request.headers.get('x-paystack-signature');
    if (!signature) {
      return NextResponse.json({ error: 'Missing Paystack signature.' }, { status: 401 });
    }

    const rawBody = await request.text();
    const expectedHash = crypto
      .createHmac('sha512', secretKey)
      .update(rawBody)
      .digest('hex');

    const signatureBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedHash, 'utf8');

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return NextResponse.json({ error: 'Invalid Paystack signature.' }, { status: 401 });
    }

    const payload = JSON.parse(rawBody) as PaystackWebhookPayload;

    if (payload.event !== 'charge.success') {
      return NextResponse.json({ received: true, ignored: payload.event ?? 'unknown' });
    }

    const reference = payload.data?.reference;
    const invoiceId = extractInvoiceId(payload);
    const paidAt = payload.data?.paid_at || new Date().toISOString();

    if (!invoiceId && !reference) {
      return NextResponse.json(
        { error: 'Missing invoice_id metadata and payment reference.' },
        { status: 400 }
      );
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Fetch existing invoice first so we can verify amount and send a receipt
    const { data: existingInvoice, error: lookupError } = invoiceId
      ? await supabaseAdmin
          .from('invoices')
          .select(
            `
            id,
            invoice_number,
            amount,
            currency,
            status,
            client:clients(name, email),
            organization:organizations(name)
          `
          )
          .eq('id', invoiceId)
          .maybeSingle()
      : await supabaseAdmin
          .from('invoices')
          .select(
            `
            id,
            invoice_number,
            amount,
            currency,
            status,
            client:clients(name, email),
            organization:organizations(name)
          `
          )
          .eq('paystack_reference', reference!)
          .maybeSingle();

    if (lookupError) {
      return NextResponse.json({ error: lookupError.message }, { status: 500 });
    }

    if (!existingInvoice) {
      return NextResponse.json({ received: true, matched: false });
    }

    // Verify paid amount (in minor units) matches invoice amount when provided
    if (typeof payload.data?.amount === 'number') {
      const expectedMinorUnits = Math.round(Number(existingInvoice.amount) * 100);
      if (payload.data.amount < expectedMinorUnits) {
        return NextResponse.json(
          { error: 'Paid amount is less than the invoice total.' },
          { status: 400 }
        );
      }
    }

    const { data: updatedInvoice, error: updateError } = await supabaseAdmin
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: paidAt,
        paystack_reference: reference ?? null,
        promised_pay_date: null,
        dispute_note: null,
      })
      .eq('id', existingInvoice.id)
      .select('id, invoice_number, status, paid_at')
      .maybeSingle();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Send a receipt email via Resend if configured and client has an email
    const clientRecord = Array.isArray(existingInvoice.client)
      ? existingInvoice.client[0]
      : existingInvoice.client;
    const orgRecord = Array.isArray(existingInvoice.organization)
      ? existingInvoice.organization[0]
      : existingInvoice.organization;

    if (
      existingInvoice.status !== 'paid' &&
      clientRecord?.email &&
      process.env.RESEND_API_KEY &&
      !process.env.RESEND_API_KEY.includes('your_resend_api_key')
    ) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const fromEmail = process.env.RESEND_FROM_EMAIL || 'InvoiceFlow <onboarding@resend.dev>';
        const orgName = orgRecord?.name || 'InvoiceFlow Vendor';
        const formattedTotal = formatCurrency(
          Number(existingInvoice.amount),
          existingInvoice.currency || 'ZAR'
        );

        await resend.emails.send({
          from: fromEmail,
          to: [clientRecord.email],
          subject: `Payment Received — Invoice ${existingInvoice.invoice_number}`,
          text: `Hi ${clientRecord.name || 'Valued Client'},\n\nThank you! We have received your payment of ${formattedTotal} for invoice ${existingInvoice.invoice_number} from ${orgName}.\n\nReference: ${reference || 'N/A'}\n\nBest regards,\n${orgName}`,
          html: `<p>Hi ${clientRecord.name || 'Valued Client'},</p><p>Thank you! We have received your payment of <strong>${formattedTotal}</strong> for invoice <strong>${existingInvoice.invoice_number}</strong> from <strong>${orgName}</strong>.</p><p style="color:#64748b;font-size:13px;">Reference: ${reference || 'N/A'}</p><p>Best regards,<br/>${orgName}</p>`,
        });
      } catch {
        // Non-blocking: webhook already updated the invoice status
      }
    }

    return NextResponse.json({
      received: true,
      event: 'charge.success',
      invoice: updatedInvoice,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Webhook processing failed.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}