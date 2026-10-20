import { useEffect, useState } from "react";
import { ApiError, createPayment, fetchPayments, fetchWorkerHealth } from "./api";
import { PaymentForm } from "./components/PaymentForm";
import { ResultCard } from "./components/ResultCard";
import { TransactionTable } from "./components/TransactionTable";
import { WorkerHealthPanel } from "./components/WorkerHealthPanel";
import type { Payment, WorkersHealthResponse } from "./types";

export default function App() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Payment | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [paymentsError, setPaymentsError] = useState("");
  const [health, setHealth] = useState<WorkersHealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState("");

  async function loadPayments() {
    setPaymentsLoading(true);
    setPaymentsError("");
    try {
      setPayments(await fetchPayments());
    } catch (loadError) {
      setPaymentsError(loadError instanceof Error ? loadError.message : "Could not load transactions.");
    } finally {
      setPaymentsLoading(false);
    }
  }

  async function loadHealth() {
    setHealthLoading(true);
    setHealthError("");
    try {
      setHealth(await fetchWorkerHealth());
    } catch (loadError) {
      setHealthError(loadError instanceof Error ? loadError.message : "Could not load worker health.");
    } finally {
      setHealthLoading(false);
    }
  }

  useEffect(() => {
    void loadPayments();
    void loadHealth();
  }, []);

  async function handleSubmit(amount: string, description: string): Promise<boolean> {
    if (!amount || !description) {
      setError("Enter an amount and a description.");
      return false;
    }
    setSubmitting(true);
    setError("");
    try {
      const payment = await createPayment(amount, description);
      setResult(payment);
      return true;
    } catch (submitError) {
      const apiError = submitError instanceof ApiError ? submitError : new ApiError("Could not submit the payment.");
      setError(apiError.message);
      if (apiError.payment) {
        setResult(apiError.payment);
      }
      return false;
    } finally {
      setSubmitting(false);
      await loadPayments();
      await loadHealth();
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-indigo-700">Distributed systems mini-project</p>
        <h1 className="mt-1 text-3xl font-semibold text-slate-900">PaySafe</h1>
        <p className="mt-2 max-w-3xl text-slate-600">
          Submit a simulated payment. FastAPI stores it in PostgreSQL, the coordinator chooses a worker, and that worker
          processes it over gRPC.
        </p>
        <p className="mt-2 text-sm font-medium text-slate-500">No real money is transferred.</p>
      </header>

      {error && (
        <p className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <PaymentForm disabled={submitting} onSubmit={handleSubmit} />
        <ResultCard payment={result} loading={submitting} />
      </div>

      <div className="mt-4">
        <WorkerHealthPanel health={health} loading={healthLoading} error={healthError} onRefresh={() => void loadHealth()} />
      </div>

      <div className="mt-4">
        <TransactionTable
          payments={payments}
          loading={paymentsLoading}
          error={paymentsError}
          onRefresh={() => void loadPayments()}
        />
      </div>
    </main>
  );
}
