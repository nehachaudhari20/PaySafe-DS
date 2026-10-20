import type { PaymentMetrics, WorkersHealthResponse } from "../types";

export function MetricsOverview({
  metrics,
  health,
  loading,
  error,
  onRefresh,
}: {
  metrics: PaymentMetrics | null;
  health: WorkersHealthResponse | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const rate =
    metrics?.success_rate == null
      ? "—"
      : `${Math.round(metrics.success_rate * 100)}%`;
  const workerLine = health
    ? health.workers
        .map(
          (worker) =>
            `${worker.worker_id} ${worker.reachable ? "reachable" : "unreachable"}`,
        )
        .join(", ")
    : "Worker health is still loading.";

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">
          System overview
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>
      {loading && (
        <p className="mt-3 text-sm text-slate-500">Loading metrics…</p>
      )}
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      {metrics && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
            <Stat
              label="Total payments"
              value={String(metrics.total_payments)}
            />
            <Stat
              label="Success rate"
              value={rate}
              detail={metrics.success_rate_basis}
            />
            <Stat label="Failed" value={String(metrics.failed_payments)} />
            <Stat label="Unknown" value={String(metrics.unknown_payments)} />
            <Stat
              label="Processing"
              value={String(metrics.processing_payments)}
            />
            <Stat
              label="Retries"
              value={String(metrics.retries)}
              detail={`${metrics.worker_attempts} worker attempts recorded`}
            />
          </dl>
          <p className="mt-3 text-sm text-slate-600">
            Workers: {workerLine || "No worker report yet."}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Reconciliation resolved {metrics.reconciliation_resolved} and left{" "}
            {metrics.reconciliation_inconclusive} inconclusive. Attempt counts
            include only payments recorded after execution history was added.
          </p>
        </>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold text-slate-900">{value}</dd>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  );
}
