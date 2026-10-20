import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  createPayment,
  fetchCoordinatorLeadership,
  fetchMetrics,
  fetchPaymentEvents,
  fetchPayments,
  fetchWorkerHealth,
} from "./api";
import { Benchmarks } from "./components/Benchmarks";
import { DemoScenarios } from "./components/DemoScenarios";
import { ExecutionTimeline } from "./components/ExecutionTimeline";
import { currentLeaderId } from "./components/FlowDiagram";
import { HowItWorks } from "./components/HowItWorks";
import { PaymentForm } from "./components/PaymentForm";
import { ResultCard } from "./components/ResultCard";
import { SidebarNav, type DashboardSection } from "./components/SidebarNav";
import { SystemStatus } from "./components/SystemStatus";
import { TransactionTable } from "./components/TransactionTable";
import { Dot } from "./components/ui";
import type { CoordinatorLeadership, Payment, PaymentEvent, PaymentMetrics, WorkersHealthResponse } from "./types";

const TITLES: Record<DashboardSection, { title: string; subtitle: string }> = {
  guide: { title: "How it works", subtitle: "The parts of the system, what can go wrong, and how each problem is handled" },
  demo: { title: "Live demo", subtitle: "Each scenario breaks one thing on purpose, then shows how the system copes" },
  payments: { title: "Try a payment", subtitle: "Send a simulated payment, then click any payment to see every step it went through" },
  status: { title: "System status", subtitle: "What is running right now, who is leader, and the switches for breaking things" },
  benchmarks: { title: "Benchmarks", subtitle: "How the system behaved when many payments were sent at once" },
};

function createIdempotencyKey(): string {
  return `pay-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function uncertaintyMessage(payment: Payment): string {
  if (payment.status === "UNKNOWN" || payment.reconciliation_required) {
    return "The result is unknown, not failed. Pressing Pay again reuses the same request ID and will not charge twice. Run reconciliation on the System status page to settle it.";
  }
  if (payment.status === "PROCESSING" || payment.status === "PENDING") {
    return "This payment is still in progress. Check it in the list instead of sending a new one.";
  }
  return "";
}

export default function App() {
  const [section, setSection] = useState<DashboardSection>("guide");
  const [demoScenario, setDemoScenario] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [errorTone, setErrorTone] = useState<"error" | "warning">("error");
  const [result, setResult] = useState<Payment | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [paymentsError, setPaymentsError] = useState("");
  const [health, setHealth] = useState<WorkersHealthResponse | null>(null);
  const [metrics, setMetrics] = useState<PaymentMetrics | null>(null);
  const [leadership, setLeadership] = useState<CoordinatorLeadership | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState("");
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
    setPaymentsError("");
    try {
      setPayments(await fetchPayments());
    } catch (loadError) {
      setPaymentsError(loadError instanceof Error ? loadError.message : "Could not load payments.");
    } finally {
      setPaymentsLoading(false);
    }
  }

  async function loadCluster() {
    await Promise.allSettled([
      fetchCoordinatorLeadership().then(setLeadership),
      fetchWorkerHealth().then(setHealth),
      fetchMetrics().then(setMetrics),
    ]);
  }

  async function loadEvents(transactionId: string) {
    setEventsLoading(true);
    setEventsError("");
    try {
      setEvents(await fetchPaymentEvents(transactionId));
    } catch (loadError) {
      setEvents([]);
      setEventsError(loadError instanceof Error ? loadError.message : "Could not load the payment's steps.");
    } finally {
      setEventsLoading(false);
    }
  }

  async function refreshAll() {
    await Promise.all([loadPayments(), loadCluster()]);
  }

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => void loadCluster(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      return;
    }
    void loadEvents(selectedId);
  }, [selectedId]);

  function watchScenario(scenarioId: string) {
    setDemoScenario(scenarioId);
    setSection("demo");
  }

  async function handleSubmit(amount: string, description: string): Promise<boolean> {
    if (!amount || !description) {
      setError("Enter an amount and what it is for.");
      return false;
    }
    setSubmitting(true);
    setError("");
    setErrorTone("error");
    logicalRequest.current = { amount, description };
    try {
      const payment = await createPayment(amount, description, idempotencyKey);
      setResult(payment);
      setSelectedId(payment.transaction_id);
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
      const apiError = submitError instanceof ApiError ? submitError : new ApiError("Could not send the payment.");
      if (apiError.payment) {
        setResult(apiError.payment);
        setSelectedId(apiError.payment.transaction_id);
        const notice = uncertaintyMessage(apiError.payment);
        setErrorTone(notice ? "warning" : "error");
        setError(notice ? `${apiError.message} ${notice}` : apiError.message);
      } else {
        setError(
          apiError.message.includes("reach")
            ? `${apiError.message} If you already pressed Pay, press it again: the same request ID prevents a double charge.`
            : apiError.message,
        );
      }
      return false;
    } finally {
      setSubmitting(false);
      await refreshAll();
    }
  }

  const faultInjection = metrics?.fault_injection_enabled ?? false;
  const reachableWorkers = health?.workers.filter((worker) => worker.reachable).length ?? 0;
  const leaderId = currentLeaderId(leadership);
  const heading = TITLES[section];

  return (
    <div className="min-h-screen bg-slate-50 md:flex">
      <aside className="bg-slate-900 md:fixed md:inset-y-0 md:w-60 md:overflow-y-auto">
        <div className="flex h-full flex-col px-3 py-5">
          <div className="px-3">
            <p className="text-lg font-semibold tracking-tight text-white">PaySafe</p>
            <p className="mt-0.5 text-xs text-slate-500">Distributed payment simulation</p>
          </div>
          <div className="mt-6 flex-1">
            <SidebarNav active={section} onSelect={setSection} />
          </div>
          <div className="mt-6 space-y-2 rounded-xl bg-white/5 p-3 text-xs text-slate-400">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Right now</p>
            <p className="flex items-center gap-2">
              <Dot tone={leaderId ? "green" : "red"} />
              {leaderId ? `Leader: Coordinator ${leaderId}` : "No leader (election running)"}
            </p>
            <p className="flex items-center gap-2">
              <Dot tone={reachableWorkers > 0 ? "green" : "red"} />
              Workers online: {reachableWorkers} of {health?.workers.length ?? 0}
            </p>
            <p className="flex items-center gap-2">
              <Dot tone={faultInjection ? "amber" : "slate"} />
              Failure switches {faultInjection ? "on" : "off"}
            </p>
          </div>
          <p className="mt-3 px-3 text-[11px] text-slate-600">Simulated payments only. No real money.</p>
        </div>
      </aside>

      <main className="min-w-0 flex-1 md:pl-60">
        <div className="mx-auto max-w-6xl px-5 py-7 lg:px-8">
          <header className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{heading.title}</h1>
            <p className="mt-1 text-sm text-slate-500">{heading.subtitle}</p>
          </header>

          {section === "guide" && <HowItWorks leadership={leadership} health={health} onWatch={watchScenario} />}

          {section === "demo" && (
            <DemoScenarios
              leadership={leadership}
              health={health}
              faultInjectionEnabled={faultInjection}
              initialId={demoScenario}
              onChanged={() => void refreshAll()}
            />
          )}

          {section === "payments" && (
            <div className="space-y-5">
              {error && (
                <p
                  className={`rounded-xl px-4 py-3 text-sm ring-1 ${
                    errorTone === "warning" ? "bg-amber-50 text-amber-950 ring-amber-200" : "bg-rose-50 text-rose-800 ring-rose-200"
                  }`}
                  role="alert"
                >
                  {error}
                </p>
              )}
              <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
                <PaymentForm
                  disabled={submitting}
                  idempotencyKey={idempotencyKey}
                  onDraftChange={rotateKeyForDraft}
                  onSubmit={handleSubmit}
                />
                <ResultCard payment={result} loading={submitting} />
              </div>
              <div className="grid gap-5 xl:grid-cols-2">
                <TransactionTable
                  payments={payments}
                  loading={paymentsLoading}
                  error={paymentsError}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onRefresh={() => void loadPayments()}
                />
                <ExecutionTimeline
                  transactionId={selectedId}
                  events={events}
                  loading={eventsLoading}
                  error={eventsError}
                  onRefresh={() => {
                    if (selectedId) {
                      void loadEvents(selectedId);
                    }
                  }}
                />
              </div>
            </div>
          )}

          {section === "status" && (
            <SystemStatus
              leadership={leadership}
              health={health}
              metrics={metrics}
              faultInjectionEnabled={faultInjection}
              onChanged={() => void refreshAll()}
            />
          )}

          {section === "benchmarks" && <Benchmarks />}
        </div>
      </main>
    </div>
  );
}
