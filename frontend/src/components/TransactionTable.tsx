import type { Payment } from "../types";
import { StatusBadge } from "./StatusBadge";
import { Button, Card, Empty, ErrorText, formatTime } from "./ui";

export function TransactionTable({
  payments,
  loading,
  error,
  selectedId,
  onSelect,
  onRefresh,
}: {
  payments: Payment[];
  loading: boolean;
  error: string;
  selectedId: string | null;
  onSelect: (transactionId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <Card
      title="Recent payments"
      subtitle="Click one to see its steps"
      action={
        <Button variant="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      }
    >
      {loading && payments.length === 0 && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <ErrorText>{error}</ErrorText>}
      {!loading && !error && payments.length === 0 && <Empty>No payments yet.</Empty>}
      {payments.length > 0 && (
        <ul className="-mx-2 divide-y divide-slate-100">
          {payments.map((payment) => {
            const selected = selectedId === payment.transaction_id;
            return (
              <li key={payment.transaction_id}>
                <button
                  type="button"
                  onClick={() => onSelect(payment.transaction_id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition ${
                    selected ? "bg-indigo-50" : "hover:bg-slate-50"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {payment.amount} · {payment.description}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      <span className="font-mono">{payment.transaction_id}</span> · {formatTime(payment.created_at)}
                      {payment.worker_id ? ` · ${payment.worker_id}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={payment.status} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
