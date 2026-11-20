import { useState, type FormEvent } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { api } from '../api';

interface Props {
  required: boolean;
  onSignedIn: () => void;
}

export default function Login({ required, onSignedIn }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = value.trim();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(token);
      setValue('');
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-5 py-10 text-slate-100">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white/[0.03] p-6">
        <h1 className="text-[15px] font-semibold tracking-tight">
          gmail-bucket <span className="font-normal text-slate-500">POC</span>
        </h1>

        <p className="mt-2 text-sm text-slate-400">
          {required
            ? 'This server listens on a public address, so it needs the token before it will answer.'
            : 'Your session expired. Sign in again to continue.'}
        </p>

        <form onSubmit={submit} className="mt-5 space-y-3">
          <label className="block text-xs font-medium text-slate-400" htmlFor="token">
            GMAIL_BUCKET_TOKEN
          </label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="the value from your .env"
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-sky-700"
          />

          {error && <p className="text-xs text-rose-400">{error}</p>}

          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-sky-800/70 bg-sky-950/60 px-3 py-2 text-sm font-medium text-sky-200 transition hover:border-sky-700 hover:bg-sky-900/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">
          The token stays on the server. This page trades it for an HttpOnly session cookie that expires after
          12 hours.
        </p>
      </div>
    </div>
  );
}
