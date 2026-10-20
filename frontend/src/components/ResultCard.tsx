import type { Payment } from "../types";
import { StatusBadge } from "./StatusBadge";

export function ResultCard({ payment, loading }: { payment: Payment | null; loading: boolean }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-live="polite">
      <h2 className="text-lg font-semibold text-slate-900">Latest result</h2>
      {loading && <p className="mt-4 text-sm text-slate-600">Waiting for a worker to finish…</p>}
      {!loading && payment === null && (
        <p className="mt-4 text-sm text-slate-500">Submit a payment to see its transaction ID, status, and worker.</p>
      )}
      {!loading && payment && (
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-slate-500">Transaction ID</dt>
            <dd className="font-mono text-base text-slate-900">{payment.transaction_id}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Status</dt>
            <dd className="mt-1">
              <StatusBadge status={payment.status} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Amount</dt>
            <dd className="text-slate-900">{payment.amount}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Description</dt>
            <dd className="text-slate-900">{payment.description}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Worker</dt>
            <dd className="text-slate-900">{payment.worker_id ?? "Not assigned"}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
