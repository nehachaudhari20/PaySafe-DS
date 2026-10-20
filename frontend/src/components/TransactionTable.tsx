import type { Payment } from "../types";
import { StatusBadge } from "./StatusBadge";

type TransactionTableProps = {
  payments: Payment[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
};

export function TransactionTable({ payments, loading, error, onRefresh }: TransactionTableProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Recent transactions</h2>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>
      {loading && <p className="mt-3 text-sm text-slate-500">Loading transactions…</p>}
      {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
      {!loading && payments.length === 0 && <p className="mt-3 text-sm text-slate-500">No payments yet.</p>}
      {payments.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="px-2 py-2 font-medium">Transaction</th>
                <th className="px-2 py-2 font-medium">Amount</th>
                <th className="px-2 py-2 font-medium">Description</th>
                <th className="px-2 py-2 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Attempts</th>
                <th className="px-2 py-2 font-medium">Worker</th>
                <th className="px-2 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.transaction_id} className="border-b border-slate-100 last:border-0">
                  <td className="px-2 py-3 font-mono text-xs text-slate-800">{payment.transaction_id}</td>
                  <td className="px-2 py-3 text-slate-800">{payment.amount}</td>
                  <td className="px-2 py-3 text-slate-800">{payment.description}</td>
                  <td className="px-2 py-3">
                    <StatusBadge status={payment.status} />
                    {payment.reconciliation_required && (
                      <span className="ml-2 inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
                        Reconcile
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-3 text-slate-800">{payment.attempt_count}</td>
                  <td className="px-2 py-3 text-slate-800">{payment.worker_id ?? "—"}</td>
                  <td className="px-2 py-3 text-slate-600">{formatTime(payment.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}
