'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Receipt } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    let active = true;

    async function checkSessionAndRedirect() {
      if (!isSupabaseConfigured) {
        router.replace('/login');
        return;
      }

      try {
        const { data } = await supabase.auth.getSession();
        if (!active) return;

        if (data.session?.user) {
          router.replace('/dashboard');
        } else {
          router.replace('/login');
        }
      } catch {
        if (active) router.replace('/login');
      }
    }

    checkSessionAndRedirect();

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="glass-panel flex items-center gap-3 rounded-xl px-6 py-4">
        <Receipt className="h-5 w-5 text-emerald-400" />
        <span className="text-sm font-medium text-slate-200">
          Loading InvoiceFlow workspace...
        </span>
        <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
      </div>
    </main>
  );
}
