import type { Payment } from "../types";
import { StatusBadge } from "./StatusBadge";
import { Card, Empty } from "./ui";

const MEANING: Record<string, string> = {
  SUCCESS: "A worker completed the payment.",
  FAILED: "A worker reported that the payment failed.",
  UNKNOWN: "No worker answered in time, so nobody knows yet. This is not a failure. Reconciliation will settle it later.",
  PROCESSING: "Still in progress. Check this payment instead of sending a new one.",
  PENDING: "Saved, but not sent to a worker yet.",
};

export function ResultCard({ payment, loading }: { payment: Payment | null; loading: boolean }) {
  return (
    <Card title="Result">
      <div aria-live="polite">
        {loading && <p className="text-sm text-slate-600">Waiting for a worker…</p>}
        {!loading && payment === null && <Empty>Your payment’s result will appear here.</Empty>}
        {!loading && payment && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-sm text-slate-900">{payment.transaction_id}</p>
              <StatusBadge status={payment.status} />
            </div>
            <p className="text-sm text-slate-600">{MEANING[payment.status] ?? payment.status}</p>
            <dl className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Amount</dt>
                <dd className="font-medium text-slate-900">{payment.amount}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Handled by</dt>
                <dd className="font-medium text-slate-900">{payment.worker_id ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Attempts</dt>
                <dd className="font-medium text-slate-900">{payment.attempt_count}</dd>
              </div>
            </dl>
            {payment.last_error && payment.status !== "SUCCESS" && <p className="text-xs text-slate-500">{payment.last_error}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
