import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { getTodayIsoDate } from '@/lib/formatters';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  context: { params: { invoiceId: string } }
) {
  try {
    const { invoiceId } = context.params;
    const supabaseAdmin = getSupabaseAdmin();

    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select(
        `
        id,
        invoice_number,
        description,
        line_items,
        amount,
        currency,
        status,
        issue_date,
        due_date,
        paid_at,
        paystack_reference,
        promised_pay_date,
        dispute_note,
        client:clients(id, name, company, email, phone),
        organization:organizations(id, name, contact_email, default_currency)
      `
      )
      .eq('id', invoiceId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
    }

    return NextResponse.json({ invoice: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load invoice.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: { invoiceId: string } }
) {
  try {
    const { invoiceId } = context.params;
    const body = (await request.json()) as {
      action: 'promise_to_pay' | 'report_issue' | 'confirm_payment';
      promised_pay_date?: string;
      dispute_note?: string;
      reference?: string;
    };

    const supabaseAdmin = getSupabaseAdmin();

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('invoices')
      .select('id, status, amount, currency')
      .eq('id', invoiceId)
      .maybeSingle();

    if (fetchError) {
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
    }

    if (body.action === 'promise_to_pay') {
      const dateStr = body.promised_pay_date?.trim();
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return NextResponse.json(
          { error: 'Please select a valid future date (YYYY-MM-DD).' },
          { status: 400 }
        );
      }

      if (dateStr < getTodayIsoDate()) {
        return NextResponse.json(
          { error: 'Promised payment date must be today or in the future.' },
          { status: 400 }
        );
      }

      const { data: updated, error: updateError } = await supabaseAdmin
        .from('invoices')
        .update({ promised_pay_date: dateStr })
        .eq('id', invoiceId)
        .select('id, promised_pay_date')
        .single();

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, invoice: updated });
    }

    if (body.action === 'report_issue') {
      const note = body.dispute_note?.trim();
      if (!note || note.length < 5) {
        return NextResponse.json(
          { error: 'Please describe the issue (at least 5 characters).' },
          { status: 400 }
        );
      }

      const { data: updated, error: updateError } = await supabaseAdmin
        .from('invoices')
        .update({ dispute_note: note })
        .eq('id', invoiceId)
        .select('id, dispute_note')
        .single();

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, invoice: updated });
    }

    if (body.action === 'confirm_payment') {
      const reference = body.reference?.trim();
      if (!reference) {
        return NextResponse.json({ error: 'Missing payment reference.' }, { status: 400 });
      }

      // If PAYSTACK_SECRET_KEY is configured, verify transaction status directly with Paystack
      const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
      if (paystackSecret && !paystackSecret.includes('your_paystack_secret_key')) {
        const verifyRes = await fetch(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
          {
            headers: {
              Authorization: `Bearer ${paystackSecret}`,
            },
            cache: 'no-store',
          }
        );

        if (!verifyRes.ok) {
          return NextResponse.json(
            { error: 'Paystack verification request failed.' },
            { status: 400 }
          );
        }

        const verifyJson = (await verifyRes.json()) as {
          status?: boolean;
          data?: { status?: string; amount?: number };
        };

        if (!verifyJson.status || verifyJson.data?.status !== 'success') {
          return NextResponse.json(
            { error: 'Transaction has not been confirmed as successful by Paystack.' },
            { status: 400 }
          );
        }
      }

      const nowIso = new Date().toISOString();
      const { data: updated, error: updateError } = await supabaseAdmin
        .from('invoices')
        .update({
          status: 'paid',
          paid_at: nowIso,
          paystack_reference: reference,
          promised_pay_date: null,
        })
        .eq('id', invoiceId)
        .select('id, status, paid_at, paystack_reference')
        .single();

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, invoice: updated });
    }

    return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update invoice.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
