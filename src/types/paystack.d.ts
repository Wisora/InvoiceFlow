declare module '@paystack/inline-js' {
  export interface PaystackTransactionResponse {
    id?: number | string;
    reference: string;
    message?: string;
    status?: string;
  }

  export interface PaystackErrorResponse {
    message: string;
  }

  export interface PaystackNewTransactionOptions {
    key: string;
    email: string;
    amount: number;
    currency?: string;
    reference?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    metadata?: Record<string, unknown>;
    onSuccess?: (transaction: PaystackTransactionResponse) => void;
    onCancel?: () => void;
    onLoad?: (response: { id: number; accessCode: string }) => void;
    onError?: (error: PaystackErrorResponse) => void;
  }

  export default class PaystackPop {
    newTransaction(options: PaystackNewTransactionOptions): unknown;
    checkout(options: PaystackNewTransactionOptions): Promise<unknown>;
  }
}
