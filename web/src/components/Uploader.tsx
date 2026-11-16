import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FolderInput, UploadCloud, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, formatSize } from '../api';

interface QueueItem {
  id: string;
  key: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

interface Props {
  bucket: string;
  baseBucket: string;
}

export default function Uploader({ bucket, baseBucket }: Props) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState('');
  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const dir = folder.trim().replace(/^\/+|\/+$/g, '');
  const destination = `${bucket === baseBucket ? 'base' : bucket}/${dir ? `${dir}/` : ''}`;

  const upload = async (files: File[]) => {
    for (const file of files) {
      const key = `${dir ? `${dir}/` : ''}${file.name}`;
      const id = crypto.randomUUID();
      setQueue((prev) => [{ id, key, progress: 0, status: 'uploading' }, ...prev.slice(0, 5)]);

      try {
        const result = await api.upload(bucket, key, file, (ratio) =>
          setQueue((prev) => prev.map((item) => (item.id === id ? { ...item, progress: ratio } : item)))
        );
        setQueue((prev) =>
          prev.map((item) => (item.id === id ? { ...item, progress: 1, status: 'done' } : item))
        );
        toast.success(`Stored ${key}`, {
          description: `${formatSize(result.size)} · etag ${result.etag.slice(0, 12)}…`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setQueue((prev) =>
          prev.map((item) => (item.id === id ? { ...item, status: 'error', error: message } : item))
        );
        toast.error(`Upload failed: ${key}`, { description: message });
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['objects', bucket] });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <FolderInput className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
          <input
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder="destination folder, e.g. 2026/trips (optional)"
            spellCheck={false}
            className="w-full rounded-lg border border-white/10 bg-[#0b0f16] py-1.5 pl-8 pr-2.5 text-sm outline-none placeholder:text-slate-600 focus:border-sky-500"
          />
        </div>
        <span className="hidden truncate rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[11px] text-slate-400 sm:block">
          {destination}
        </span>
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload([...event.dataTransfer.files]);
        }}
        className={`cursor-pointer rounded-xl border border-dashed px-4 py-6 text-center transition ${
          dragging
            ? 'border-sky-500 bg-sky-950/30 text-slate-100'
            : 'border-slate-700 bg-[#101621] text-slate-400 hover:border-slate-600 hover:text-slate-300'
        }`}
      >
        <UploadCloud className="mx-auto mb-1.5 size-5" />
        <p className="text-sm">
          <span className="font-semibold text-slate-200">Drop files here</span> or click to choose
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
          {destination}filename
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) void upload([...event.target.files]);
          event.target.value = '';
        }}
      />

      {queue.length > 0 && (
        <div className="flex flex-col gap-1">
          {queue.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2.5 py-1.5 text-xs"
            >
              {item.status === 'done' ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
              ) : (
                <UploadCloud className="size-3.5 shrink-0 text-slate-500" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-slate-300">{item.key}</span>
              {item.status === 'uploading' && (
                <span className="w-24 shrink-0">
                  <span className="block h-1 overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full bg-sky-500 transition-[width]"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </span>
                </span>
              )}
              {item.status === 'error' && (
                <span className="max-w-[14rem] truncate text-red-400" title={item.error}>
                  {item.error}
                </span>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setQueue([])}
            className="inline-flex items-center gap-1 self-start rounded-md px-1.5 py-1 text-[11px] text-slate-500 hover:text-slate-300"
          >
            <X className="size-3" /> clear list
          </button>
        </div>
      )}
    </div>
  );
}
