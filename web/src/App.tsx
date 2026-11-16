import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, BASE_BUCKET } from './api';
import Header from './components/Header';
import BucketsPanel from './components/BucketsPanel';
import ObjectsPanel from './components/ObjectsPanel';

export default function App() {
  const statusQuery = useQuery({ queryKey: ['status'], queryFn: api.status });

  const baseBucket = statusQuery.data?.baseBucket ?? BASE_BUCKET;
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // Select the base folder once the backend has answered.
  useEffect(() => {
    if (selected === null && statusQuery.data) setSelected(statusQuery.data.baseBucket);
  }, [selected, statusQuery.data]);

  const bucket = selected ?? baseBucket;

  return (
    <div className="min-h-full text-slate-100">
      <Header status={statusQuery.data} isLoading={statusQuery.isLoading} />

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
