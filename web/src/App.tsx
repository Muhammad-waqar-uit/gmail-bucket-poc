import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api, ApiError, BASE_BUCKET } from './api';
import Header from './components/Header';
import BucketsPanel from './components/BucketsPanel';
import ObjectsPanel from './components/ObjectsPanel';
import Login from './components/Login';

export default function App() {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false });

  const signedIn = sessionQuery.data?.authenticated === true;

  // Everything behind /api is gated, so hold the panels back until the session is known.
  const statusQuery = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    enabled: signedIn,
    retry: false,
  });

  const baseBucket = statusQuery.data?.baseBucket ?? BASE_BUCKET;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // Nothing selected yet means the base folder, which is also the first entry in the list.
  const bucket = selected ?? baseBucket;

  const expired = statusQuery.error instanceof ApiError && statusQuery.error.status === 401;

  if (sessionQuery.isLoading) {
    return (
      <div className="flex min-h-full items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 className="size-4 animate-spin" />
        connecting
      </div>
    );
  }

  if (!signedIn || expired) {
    return (
      <Login
        required={sessionQuery.data?.required ?? true}
        onSignedIn={() => queryClient.invalidateQueries()}
      />
    );
  }

  return (
    <div className="min-h-full text-slate-100">
      <Header
        status={statusQuery.data}
        isLoading={statusQuery.isLoading}
        canSignOut={sessionQuery.data?.required === true}
      />

      <main className="mx-auto grid max-w-6xl gap-5 px-5 py-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <BucketsPanel
          selected={bucket}
          baseBucket={baseBucket}
          onSelect={(next) => {
            setSelected(next);
            setFilter('');
          }}
        />
        <ObjectsPanel
          bucket={bucket}
          baseBucket={baseBucket}
          filter={filter}
          onFilterChange={setFilter}
        />
      </main>
    </div>
  );
}
