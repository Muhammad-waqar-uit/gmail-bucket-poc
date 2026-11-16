import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, ImageIcon, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, formatSize, objectUrl, type ObjectInfo } from '../api';

interface Props {
  bucket: string;
  objects: ObjectInfo[];
}

export default function ObjectTable({ bucket, objects }: Props) {
  const queryClient = useQueryClient();

  const deleteObject = useMutation({
    mutationFn: (key: string) => api.deleteObject(bucket, key),
    onSuccess: async (_data, key) => {
      toast.success(`Deleted ${key}`);
      await queryClient.invalidateQueries({ queryKey: ['objects', bucket] });
    },
    onError: (error) => toast.error('Could not delete object', { description: error.message }),
  });

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.07em] text-slate-500">
            <th className="px-3 py-2 font-semibold">Key</th>
            <th className="px-3 py-2 font-semibold">Size</th>
            <th className="hidden px-3 py-2 font-semibold sm:table-cell">Modified</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {objects.map((object) => {
            const isImage = object.contentType.startsWith('image/');
            return (
              <tr key={object.key} className="border-t border-white/5 hover:bg-white/[0.03]">
                <td className="max-w-0 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded border border-white/10 bg-[#0b0f16]">
                      {isImage ? (
                        <img
                          src={objectUrl(bucket, object.key)}
                          alt=""
                          loading="lazy"
                          className="size-7 object-cover"
                        />
                      ) : (
                        <ImageIcon className="size-3.5 text-slate-600" />
                      )}
                    </span>
                    <a
                      href={objectUrl(bucket, object.key)}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-mono text-[12.5px] text-slate-200 hover:text-sky-300"
                      title={`${object.key} · ${object.contentType} · etag ${object.etag}`}
                    >
                      {object.key}
                    </a>
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">
                  {formatSize(object.size)}
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-slate-400 sm:table-cell">
                  {new Date(object.lastModified).toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <a
                      href={objectUrl(bucket, object.key, true)}
                      className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300 transition hover:bg-white/10"
                      title="Download"
                    >
                      <Download className="size-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete ${object.key}?`)) deleteObject.mutate(object.key);
                      }}
                      disabled={deleteObject.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-xs text-slate-500 transition hover:border-red-900/60 hover:bg-red-950/40 hover:text-red-400"
                      title="Delete"
                    >
                      {deleteObject.isPending && deleteObject.variables === object.key ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
