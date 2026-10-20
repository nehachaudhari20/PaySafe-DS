import type { WorkersHealthResponse } from "../types";

type WorkerHealthProps = {
  health: WorkersHealthResponse | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
};

export function WorkerHealthPanel({ health, loading, error, onRefresh }: WorkerHealthProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Worker health</h2>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>
      {loading && <p className="mt-3 text-sm text-slate-500">Checking workers…</p>}
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      {health && !health.coordinator_reachable && (
        <p className="mt-3 text-sm text-amber-800">{health.detail ?? "Coordinator is unavailable."}</p>
      )}
      {health && health.workers.length > 0 && (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {health.workers.map((worker) => (
            <li key={worker.worker_id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-3">
              <span className="font-medium text-slate-800">{worker.worker_id}</span>
              <span className={worker.reachable ? "text-sm font-semibold text-emerald-700" : "text-sm font-semibold text-rose-700"}>
                {worker.reachable ? "Reachable" : "Unreachable"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
