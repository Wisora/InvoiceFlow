export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';

export type ReliabilityLabel = 'On-Time' | 'Slow Payer' | 'At Risk';

export type ReminderTier =
  | 'upcoming'
  | 'due_today'
  | 'overdue_friendly'
  | 'overdue_firm'
  | 'manual';

export interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
}

export interface Organization {
  id: string;
  owner_id: string;
  name: string;
  contact_email: string | null;
  default_currency: string;
  created_at: string;
}

export interface Client {
  id: string;
  organization_id: string;
  name: string;
  company: string | null;
  email: string;
  phone: string | null;
  reliability_label: ReliabilityLabel;
  created_at: string;
}

export interface Invoice {
  id: string;
  organization_id: string;
  client_id: string;
  invoice_number: string;
  description: string;
  line_items: LineItem[];
  amount: number;
  currency: string;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string;
  paid_at: string | null;
  paystack_reference: string | null;
  promised_pay_date: string | null;
  dispute_note: string | null;
  last_reminded_at: string | null;
  created_at: string;
  client?: Client;
  organization?: Pick<Organization, 'id' | 'name' | 'contact_email' | 'default_currency'>;
}

export interface ReminderLog {
  id: string;
  organization_id: string;
  invoice_id: string;
  channel: 'email' | 'whatsapp';
  template_tier: ReminderTier;
  recipient: string;
  subject: string | null;
  provider_message_id: string | null;
  status: string;
  sent_at: string;
  invoice?: {
    invoice_number: string;
  };
}
