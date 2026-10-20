import { useEffect, useRef, useState } from "react";
import { ApiError, createPayment, fetchPayments, fetchWorkerHealth } from "./api";
import { FaultPanel } from "./components/FaultPanel";
import { PaymentForm } from "./components/PaymentForm";
import { ResultCard } from "./components/ResultCard";
import { TransactionTable } from "./components/TransactionTable";
import { WorkerHealthPanel } from "./components/WorkerHealthPanel";
import type { Payment, WorkersHealthResponse } from "./types";

function createIdempotencyKey(): string {
  return `pay-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function uncertaintyMessage(payment: Payment): string {
  if (payment.reconciliation_required) {
    return "This payment is still processing and needs reconciliation. It was not marked failed, and retrying will not send it to a worker again.";
  }
  if (payment.status === "UNKNOWN") {
    return "The outcome is unknown, not failed. Retrying reuses this idempotency key and does not start a second payment. Run reconciliation after the worker may have recorded a result.";
  }
  if (payment.status === "PROCESSING" || payment.status === "PENDING") {
    return "This payment's outcome is uncertain. Check this transaction instead of starting a new one. Retrying reuses the same idempotency key.";
  }
  return "";
}

export default function App() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [errorTone, setErrorTone] = useState<"error" | "warning">("error");
  const [result, setResult] = useState<Payment | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [paymentsError, setPaymentsError] = useState("");
  const [health, setHealth] = useState<WorkersHealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const logicalRequest = useRef<{ amount: string; description: string } | null>(null);

  function rotateKeyForDraft(amount: string, description: string) {
    const current = logicalRequest.current;
    if (current && (current.amount !== amount.trim() || current.description !== description.trim())) {
      logicalRequest.current = null;
      setIdempotencyKey(createIdempotencyKey());
    }
  }

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
    setErrorTone("error");
    logicalRequest.current = { amount, description };
    try {
      const payment = await createPayment(amount, description, idempotencyKey);
      setResult(payment);
      const notice = uncertaintyMessage(payment);
      if (notice) {
        setErrorTone("warning");
        setError(notice);
        return false;
      }
      logicalRequest.current = null;
      setIdempotencyKey(createIdempotencyKey());
      return true;
    } catch (submitError) {
      const apiError = submitError instanceof ApiError ? submitError : new ApiError("Could not submit the payment.");
      if (apiError.payment) {
        setResult(apiError.payment);
        const notice = uncertaintyMessage(apiError.payment);
        if (notice) {
          setErrorTone("warning");
          setError(`${apiError.message} ${notice}`);
        } else {
          setError(apiError.message);
        }
      } else {
        setError(
          apiError.message.includes("reach")
            ? `${apiError.message} If a payment was already submitted, retry with the same idempotency key instead of starting a new one.`
            : apiError.message,
        );
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
        <p
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            errorTone === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-950"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <PaymentForm
          disabled={submitting}
          idempotencyKey={idempotencyKey}
          onDraftChange={rotateKeyForDraft}
          onSubmit={handleSubmit}
        />
        <ResultCard payment={result} loading={submitting} />
      </div>

      <div className="mt-4">
        <WorkerHealthPanel health={health} loading={healthLoading} error={healthError} onRefresh={() => void loadHealth()} />
      </div>

      <div className="mt-4">
        <FaultPanel />
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
