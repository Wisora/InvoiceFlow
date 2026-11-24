import type { Metadata } from 'next';
import { JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'InvoiceFlow — Automated B2B Accounts Receivable Chaser',
  description:
    'Collect faster with automated invoice reminders, Paystack online checkout, WhatsApp chasing, and client payment reliability insights.',
  openGraph: {
    title: 'InvoiceFlow — Automated B2B Accounts Receivable Chaser',
    description:
      'Collect faster with automated invoice reminders, Paystack online checkout, WhatsApp chasing, and client payment reliability insights.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${plusJakartaSans.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen bg-slate-950 font-sans text-slate-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-100">
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        >
          <div className="absolute -top-40 left-1/2 h-[540px] w-[960px] -translate-x-1/2 rounded-full bg-emerald-500/[0.06] blur-3xl" />
          <div className="absolute bottom-0 right-0 h-[420px] w-[620px] rounded-full bg-sky-500/[0.04] blur-3xl" />
        </div>
        {children}
      </body>
    </html>
  );
}
