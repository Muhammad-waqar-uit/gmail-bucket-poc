import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, BASE_BUCKET, type ObjectInfo } from '../api';

interface Props {
  bucket: string;
  object: ObjectInfo;
  onClose: () => void;
}

const labelFor = (bucket: string) => (bucket === BASE_BUCKET ? 'the base folder' : bucket);

export default function MoveDialog({ bucket, object, onClose }: Props) {
  const queryClient = useQueryClient();
  const bucketsQuery = useQuery({ queryKey: ['buckets'], queryFn: api.buckets });
  const [toBucket, setToBucket] = useState(bucket);
  const [toKey, setToKey] = useState(object.key);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const move = useMutation({
    mutationFn: () => api.moveObject(bucket, object.key, toBucket, toKey.trim()),
    onSuccess: async (moved) => {
      toast.success(`Moved to ${labelFor(toBucket)}/${moved.key}`);
      await queryClient.invalidateQueries({ queryKey: ['objects'] });
      onClose();
    },
    onError: (error) => toast.error('Could not move object', { description: error.message }),
  });

  const key = toKey.trim();
  const unchanged = toBucket === bucket && key === object.key;
  const invalid = !key || key.endsWith('/');

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <form
        role="dialog"
        aria-label="Move or rename object"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!unchanged && !invalid) move.mutate();
        }}
        className="w-full max-w-md rounded-xl border border-white/10 bg-[#161b22] p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-100">Move or rename</h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500" title={`${bucket}/${object.key}`}>
              {bucket === BASE_BUCKET ? 'base' : bucket}/{object.key}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-500 transition hover:bg-white/5 hover:text-slate-300"
          >
            <X className="size-4" />
          </button>
        </div>

        <label
          htmlFor="move-bucket"
          className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-500"
        >
          Destination bucket
        </label>
        <select
          id="move-bucket"
          value={toBucket}
          onChange={(event) => setToBucket(event.target.value)}
          className="mb-3 w-full rounded-lg border border-white/10 bg-[#0b0f16] px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500"
        >
          <option value={BASE_BUCKET}>base (main folder)</option>
          {bucketsQuery.data?.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <label
          htmlFor="move-key"
          className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-500"
        >
          Key / path
        </label>
        <input
          id="move-key"
          ref={inputRef}
          value={toKey}
          onChange={(event) => setToKey(event.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-white/10 bg-[#0b0f16] px-2.5 py-1.5 font-mono text-sm outline-none focus:border-sky-500"
        />
        <p className="mt-2 truncate font-mono text-[11px] text-slate-500" title={`${toBucket}/${key}`}>
          → {toBucket === BASE_BUCKET ? 'base' : toBucket}/{key || '…'}
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={move.isPending || unchanged || invalid}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-40"
          >
            {move.isPending ? <Loader2 className="size-4 animate-spin" /> : <ArrowRightLeft className="size-4" />}
            Move
          </button>
        </div>

        {unchanged && (
          <p className="mt-2 text-[11px] text-slate-500">Pick another bucket or change the key to move.</p>
        )}
        {invalid && <p className="mt-2 text-[11px] text-amber-400">A key is required and cannot end with “/”.</p>}
      </form>
    </div>
  );
}
