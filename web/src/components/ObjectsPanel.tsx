import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { api } from '../api';
import Uploader from './Uploader';
import ObjectTable from './ObjectTable';

interface Props {
  bucket: string;
  baseBucket: string;
  filter: string;
  onFilterChange: (value: string) => void;
}

function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function ObjectsPanel({ bucket, baseBucket, filter, onFilterChange }: Props) {
  const prefix = useDebounced(filter);

  const objectsQuery = useQuery({
    queryKey: ['objects', bucket, prefix],
    queryFn: () => api.objects(bucket, prefix),
  });

  const isBase = bucket === baseBucket;
  const objects = objectsQuery.data ?? [];

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-white/10 bg-[#161b22] p-3">
      <div className="flex flex-wrap items-baseline gap-2 px-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
          Objects
        </h2>
        <span className="text-sm text-slate-300">
          {isBase ? 'base (main folder)' : bucket}
          <span className="text-slate-500">/</span>
        </span>
        <span className="flex-1" />
        {!objectsQuery.isLoading && (
          <span className="text-xs text-slate-500">
            {objects.length} {objects.length === 1 ? 'object' : 'objects'}
          </span>
        )}
      </div>

      <Uploader bucket={bucket} baseBucket={baseBucket} />

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
          <input
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="filter by prefix, e.g. 2026/"
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-[#0b0f16] py-1.5 pl-8 pr-2.5 text-sm outline-none placeholder:text-slate-600 focus:border-sky-500"
          />
        </div>
        <button
          type="button"
          onClick={() => objectsQuery.refetch()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs text-slate-300 transition hover:bg-white/10"
          title="Refresh objects"
        >
          {objectsQuery.isFetching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>
      </div>

      {objectsQuery.isError && (
        <p className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {objectsQuery.error.message}
        </p>
      )}

      {objectsQuery.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
          <Loader2 className="size-4 animate-spin" /> loading objects…
        </div>
      ) : objects.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">
          No objects here yet. Drop files above to store them in{' '}
          {isBase ? 'the base folder' : `bucket "${bucket}"`}.
        </p>
      ) : (
        <ObjectTable bucket={bucket} objects={objects} />
      )}
    </section>
  );
}
