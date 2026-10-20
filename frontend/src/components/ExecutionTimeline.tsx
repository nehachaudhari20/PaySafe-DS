import type { PaymentEvent } from "../types";

const tone: Record<string, string> = {
  PAYMENT_SUCCEEDED: "border-emerald-300 bg-emerald-50",
  RECONCILIATION_RESOLVED: "border-emerald-300 bg-emerald-50",
  WORKER_RESULT_RECEIVED: "border-sky-300 bg-sky-50",
  PAYMENT_FAILED: "border-rose-300 bg-rose-50",
  WORKER_UNAVAILABLE: "border-rose-200 bg-rose-50",
  ATTEMPT_RETRIED: "border-amber-300 bg-amber-50",
  PAYMENT_MARKED_UNKNOWN: "border-violet-300 bg-violet-50",
  RECONCILIATION_INCONCLUSIVE: "border-violet-300 bg-violet-50",
  COORDINATOR_TIMEOUT: "border-violet-300 bg-violet-50",
  RECONCILIATION_STARTED: "border-indigo-200 bg-indigo-50",
};

export function ExecutionTimeline({
  transactionId,
  events,
  loading,
  error,
  onRefresh,
}: {
  transactionId: string | null;
  events: PaymentEvent[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">
          Execution history
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!transactionId}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          Refresh
        </button>
      </div>
      {!transactionId && (
        <p className="mt-3 text-sm text-slate-500">
          Select a transaction to see how it was handled.
        </p>
      )}
      {transactionId && loading && (
        <p className="mt-3 text-sm text-slate-500">
          Loading execution history…
        </p>
      )}
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      {transactionId && !loading && !error && events.length === 0 && (
        <p className="mt-3 text-sm text-slate-500">
          No execution events were recorded for this payment.
        </p>
      )}
      {events.length > 0 && (
        <ol className="mt-4 space-y-2">
          {events.map((event) => (
            <li
              key={event.id}
              className={`rounded-lg border px-3 py-2 text-sm ${tone[event.event_type] ?? "border-slate-200 bg-slate-50"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-slate-900">
                  {label(event.event_type)}
                </p>
                <time
                  className="text-xs text-slate-500"
                  dateTime={event.created_at}
                >
                  {formatTime(event.created_at)}
                </time>
              </div>
              <p className="mt-1 text-slate-700">{event.message}</p>
              <p className="mt-1 text-xs text-slate-500">
                {event.service}
                {event.worker_id ? ` · ${event.worker_id}` : ""}
                {event.attempt ? ` · attempt ${event.attempt}` : ""}
                {event.lamport_time ? ` · Lamport ${event.lamport_time}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
function label(eventType: string): string {
  return eventType
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}
