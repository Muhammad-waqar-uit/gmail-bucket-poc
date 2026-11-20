import { useQueryClient } from '@tanstack/react-query';
import { Database, ExternalLink, HardDrive, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { api, type Status } from '../api';

const MODE_STYLES: Record<Status['mode'], string> = {
  drive: 'border-emerald-800/70 bg-emerald-950/60 text-emerald-300',
  gmail: 'border-sky-800/70 bg-sky-950/60 text-sky-300',
  memory: 'border-amber-800/70 bg-amber-950/60 text-amber-300',
};

const MODE_LABEL: Record<Status['mode'], string> = {
  drive: 'Drive backend',
  gmail: 'Gmail backend',
  memory: 'In-memory backend',
};

interface Props {
  status?: Status;
  isLoading: boolean;
  /** Only meaningful when the API requires a token. */
  canSignOut?: boolean;
}

export default function Header({ status, isLoading, canSignOut = false }: Props) {
  const queryClient = useQueryClient();

  async function signOut() {
    // A failed request still means the cookie is gone on this end; the session query
    // below decides what the UI shows.
    await api.logout().catch(() => {});
    queryClient.clear();
  }

  return (
    <header className="sticky top-0 z-10 border-b border-white/10 bg-[#0d1117]/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
        <h1 className="text-[15px] font-semibold tracking-tight">
          gmail-bucket <span className="font-normal text-slate-500">POC</span>
        </h1>

        {isLoading || !status ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-400">
            <Loader2 className="size-3 animate-spin" />
            connecting
          </span>
        ) : (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${MODE_STYLES[status.mode]}`}
            title={status.reason}
          >
            <Database className="size-3" />
            {MODE_LABEL[status.mode]}
          </span>
        )}

        <span className="flex-1" />

        {status &&
          (status.baseUrl ? (
            <a
              href={status.baseUrl}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex max-w-[28rem] items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-400 transition hover:border-white/20 hover:bg-white/10 hover:text-slate-200"
              title={`${status.base} — open the base folder`}
            >
              <HardDrive className="size-3 shrink-0" />
              <span className="truncate">base: {status.base}</span>
              <ExternalLink className="size-3 shrink-0 opacity-60 group-hover:opacity-100" />
            </a>
          ) : (
            <span
              className="inline-flex max-w-[28rem] items-center gap-1.5 truncate rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-400"
              title={status.base}
            >
              <HardDrive className="size-3 shrink-0" />
              <span className="truncate">base: {status.base}</span>
            </span>
          ))}

        <button
          type="button"
          onClick={() => queryClient.invalidateQueries()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-white/20 hover:bg-white/10"
          title="Refresh everything"
        >
          <RefreshCw className="size-3" />
          Refresh
        </button>

        {canSignOut && (
          <button
            type="button"
            onClick={signOut}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-400 transition hover:border-white/20 hover:bg-white/10 hover:text-slate-200"
            title="Drop the session cookie"
          >
            <LogOut className="size-3" />
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}
