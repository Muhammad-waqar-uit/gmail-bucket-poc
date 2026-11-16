import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, FolderOpen, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';

interface Props {
  selected: string;
  baseBucket: string;
  onSelect: (bucket: string) => void;
}

export default function BucketsPanel({ selected, baseBucket, onSelect }: Props) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');

  const bucketsQuery = useQuery({ queryKey: ['buckets'], queryFn: api.buckets });

  const createBucket = useMutation({
    mutationFn: (bucket: string) => api.createBucket(bucket),
    onSuccess: async (_data, bucket) => {
      toast.success(`Bucket "${bucket}" created`);
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['buckets'] });
      onSelect(bucket);
    },
    onError: (error) => toast.error('Could not create bucket', { description: error.message }),
  });

  const deleteBucket = useMutation({
    mutationFn: (bucket: string) => api.deleteBucket(bucket),
    onSuccess: async (_data, bucket) => {
      toast.success(`Bucket "${bucket}" deleted`);
      await queryClient.invalidateQueries({ queryKey: ['buckets'] });
      await queryClient.invalidateQueries({ queryKey: ['objects'] });
      if (selected === bucket) onSelect(baseBucket);
    },
    onError: (error) => toast.error('Could not delete bucket', { description: error.message }),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const bucket = name.trim().toLowerCase();
    if (!bucket) return;
    createBucket.mutate(bucket);
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-white/10 bg-[#161b22] p-3">
      <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        Buckets
      </h2>

      <form onSubmit={submit} className="flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="new-bucket"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#0b0f16] px-2.5 py-1.5 text-sm outline-none placeholder:text-slate-600 focus:border-sky-500"
        />
        <button
          type="submit"
          disabled={createBucket.isPending || !name.trim()}
          className="inline-flex items-center justify-center rounded-lg bg-sky-600 px-2.5 py-1.5 text-white transition hover:bg-sky-500 disabled:opacity-40"
          title="Create a bucket (a folder in the base)"
        >
          {createBucket.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </button>
      </form>

      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          onClick={() => onSelect(baseBucket)}
          title="The base folder itself — objects here are not in any bucket"
          className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition ${
            selected === baseBucket
              ? 'border-sky-700/60 bg-sky-950/40 text-sky-100'
              : 'border-transparent text-slate-300 hover:bg-white/5'
          }`}
        >
          <FolderOpen className="size-4 shrink-0 text-sky-400" />
          <span className="truncate">base (main folder)</span>
        </button>

        {bucketsQuery.isLoading && (
          <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-slate-500">
            <Loader2 className="size-3 animate-spin" /> loading buckets…
          </div>
        )}

        {bucketsQuery.isError && (
          <p className="px-2.5 py-2 text-xs text-red-400">{bucketsQuery.error.message}</p>
        )}

        {bucketsQuery.data?.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-slate-500">No buckets yet — create one above.</p>
        )}

        {bucketsQuery.data?.map((bucket) => (
          <div
            key={bucket}
            className={`group flex items-center gap-1 rounded-lg border pr-1 transition ${
              selected === bucket
                ? 'border-sky-700/60 bg-sky-950/40'
                : 'border-transparent hover:bg-white/5'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(bucket)}
              className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm text-slate-200"
            >
              <Folder className="size-4 shrink-0 text-slate-400" />
              <span className="truncate">{bucket}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete bucket "${bucket}"? Objects go to Trash.`)) {
                  deleteBucket.mutate(bucket);
                }
              }}
              disabled={deleteBucket.isPending}
              className="rounded-md p-1.5 text-slate-500 opacity-0 transition group-hover:opacity-100 hover:bg-red-950/50 hover:text-red-400"
              title="Delete bucket"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
