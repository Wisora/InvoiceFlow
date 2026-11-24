'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  Receipt,
} from 'lucide-react';
import { isSupabaseConfigured, supabase } from '@/lib/supabaseClient';

type AuthMode = 'signin' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function redirectIfAuthed() {
      if (!isSupabaseConfigured) {
        setCheckingSession(false);
        return;
      }

      try {
        const { data } = await supabase.auth.getSession();
        if (active && data.session?.user) {
          router.replace('/dashboard');
          return;
        }
      } catch {
        // Ignore session check failure and render login form
      } finally {
        if (active) setCheckingSession(false);
      }
    }

    redirectIfAuthed();

    return () => {
      active = false;
    };
  }, [router]);

  async function ensureOrganizationExists(userId: string, userEmail: string, orgName?: string) {
    const { data: existing, error: selectError } = await supabase
      .from('organizations')
      .select('id')
      .eq('owner_id', userId)
      .limit(1)
      .maybeSingle();

    if (selectError) throw selectError;

    if (!existing) {
      const derivedName =
        orgName?.trim() ||
        userEmail
          .split('@')[0]
          .replace(/[._-]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()) + ' Holdings';

      const { error: insertError } = await supabase.from('organizations').insert({
        owner_id: userId,
        name: derivedName,
        contact_email: userEmail,
        default_currency: 'ZAR',
      });

      if (insertError) throw insertError;
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (!isSupabaseConfigured) {
      setError(
        'Supabase environment variables are not configured yet. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local.'
      );
      return;
    }

    if (!email.trim() || !password) {
      setError('Please enter your work email and password.');
      return;
    }

    if (mode === 'signup' && !organizationName.trim()) {
      setError('Please enter your company or organization name.');
      return;
    }

    setLoading(true);

    try {
      if (mode === 'signin') {
        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

        if (signInError) {
          setError(signInError.message);
          return;
        }

        if (data.user) {
          await ensureOrganizationExists(data.user.id, data.user.email ?? email.trim());
          router.replace('/dashboard');
        }
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: {
              organization_name: organizationName.trim(),
            },
          },
        });

        if (signUpError) {
          setError(signUpError.message);
          return;
        }

        if (data.session && data.user) {
          await ensureOrganizationExists(
            data.user.id,
            data.user.email ?? email.trim(),
            organizationName.trim()
          );
          router.replace('/dashboard');
        } else {
          setNotice(
            'Account created. Check your inbox to verify your email address, then sign in.'
          );
          setMode('signin');
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="glass-panel flex items-center gap-3 rounded-xl px-5 py-3.5 text-sm text-slate-300">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
          <span>Checking session...</span>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
            <Receipt className="h-6 w-6 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">
            InvoiceFlow
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Automated B2B accounts receivable and payment recovery
          </p>
        </div>

        <div className="glass-panel rounded-2xl p-7 shadow-2xl shadow-black/40">
          <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl border border-slate-800/80 bg-slate-950/70 p-1">
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError(null);
                setNotice(null);
              }}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                mode === 'signin'
                  ? 'bg-slate-800 text-slate-50 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setError(null);
                setNotice(null);
              }}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                mode === 'signup'
                  ? 'bg-slate-800 text-slate-50 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Create Account
            </button>
          </div>

          {!isSupabaseConfigured && (
            <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-xs text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div>
                <p className="font-semibold text-amber-100">Supabase keys required</p>
                <p className="mt-0.5 leading-relaxed text-amber-200/80">
                  Configure <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
                  <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to enable
                  workspace sign-in.
                </p>
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-xs text-rose-200"
            >
              {error}
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-3 text-xs text-emerald-200"
            >
              {notice}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <div>
                <label
                  htmlFor="organization"
                  className="mb-1.5 block text-xs font-medium text-slate-300"
                >
                  Organization Name
                </label>
                <div className="relative">
                  <Building2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    id="organization"
                    type="text"
                    value={organizationName}
                    onChange={(e) => setOrganizationName(e.target.value)}
                    placeholder="Cape Logistics (Pty) Ltd"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/70 py-2.5 pl-10 pr-3.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-xs font-medium text-slate-300"
              >
                Work Email
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="finance@company.co.za"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 py-2.5 pl-10 pr-3.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-xs font-medium text-slate-300"
              >
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 py-2.5 pl-10 pr-10 text-sm text-slate-100 placeholder:text-slate-600 focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{mode === 'signin' ? 'Signing in...' : 'Creating workspace...'}</span>
                </>
              ) : (
                <>
                  <span>{mode === 'signin' ? 'Sign In to Dashboard' : 'Create Workspace'}</span>
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          Protected by Supabase Auth &amp; Row Level Security · ZAR default currency
        </p>
      </div>
    </main>
  );
}
