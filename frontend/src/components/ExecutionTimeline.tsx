import type { PaymentEvent } from "../types";
import { Button, Card, Dot, Empty, ErrorText, formatTime, humanize } from "./ui";

const tone: Record<string, "green" | "red" | "amber" | "slate" | "violet" | "indigo"> = {
  IDEMPOTENCY_REPLAYED: "indigo",
  IDEMPOTENCY_PAYLOAD_CONFLICT: "amber",
  PAYMENT_SUCCEEDED: "green",
  RECONCILIATION_RESOLVED: "green",
  WORKER_RESULT_RECEIVED: "indigo",
  PAYMENT_FAILED: "red",
  WORKER_UNAVAILABLE: "red",
  ATTEMPT_RETRIED: "amber",
  PAYMENT_MARKED_UNKNOWN: "violet",
  RECONCILIATION_INCONCLUSIVE: "violet",
  COORDINATOR_TIMEOUT: "violet",
  RECONCILIATION_STARTED: "indigo",
};

const SERVICE: Record<string, string> = {
  api: "Payment API",
  coordinator: "Coordinator",
  worker: "Worker",
};

export function TimelineList({ events }: { events: PaymentEvent[] }) {
  return (
    <ol className="relative ml-1 border-l border-slate-200">
      {events.map((event) => (
        <li key={event.id} className="relative pb-4 pl-5 last:pb-0">
          <span className="absolute -left-[5px] top-1.5">
            <Dot tone={tone[event.event_type] ?? "slate"} />
          </span>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="text-sm font-medium text-slate-900">{humanize(event.event_type)}</p>
            <p className="text-xs tabular-nums text-slate-400">
              {event.lamport_time ? (
                <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">L{event.lamport_time}</span>
              ) : null}
              {formatTime(event.created_at)}
            </p>
          </div>
          <p className="mt-0.5 text-sm text-slate-600">{event.message}</p>
          <p className="mt-0.5 text-xs text-slate-400">
            {SERVICE[event.service] ?? event.service}
            {event.worker_id ? ` · ${event.worker_id}` : ""}
            {event.attempt ? ` · attempt ${event.attempt}` : ""}
          </p>
        </li>
      ))}
    </ol>
  );
}

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
    <Card
      title="Every step of this payment"
      subtitle={transactionId ?? "Click a payment on the left"}
      action={
        <Button variant="ghost" onClick={onRefresh} disabled={!transactionId}>
          Refresh
        </Button>
      }
    >
      {!transactionId && <Empty>Click any payment to see which program handled it, and in what order.</Empty>}
      {transactionId && loading && events.length === 0 && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {transactionId && !loading && !error && events.length === 0 && <Empty>No steps were recorded for this payment.</Empty>}
      {events.length > 0 && <TimelineList events={events} />}
      {events.length > 0 && (
        <p className="mt-4 text-xs text-slate-400">
          “L” is a logical clock (Lamport time). It always goes up from cause to effect across the API, coordinator and worker, even if
          their real clocks disagree.
        </p>
      )}
    </Card>
  );
}
