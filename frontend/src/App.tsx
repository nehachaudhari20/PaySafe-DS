import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  createPayment,
  fetchCoordinatorLeadership,
  fetchFaults,
  fetchMetrics,
  fetchPaymentEvents,
  fetchPayments,
  fetchWorkerHealth,
} from "./api";
import { hasAbnormalWorkerFaults, shortFaultSummary, summarizeAbnormalFaults } from "./faultStatus";
import { Benchmarks } from "./components/Benchmarks";
import { DemoScenarios } from "./components/DemoScenarios";
import { ExecutionTimeline } from "./components/ExecutionTimeline";
import { currentLeaderId } from "./components/FlowDiagram";
import { Home } from "./components/Home";
import { InteractivePaymentCases } from "./components/InteractivePaymentCases";
import { PaymentForm } from "./components/PaymentForm";
import { ResultCard } from "./components/ResultCard";
import { SidebarNav, type DashboardSection } from "./components/SidebarNav";
import { SystemStatus } from "./components/SystemStatus";
import { TransactionTable } from "./components/TransactionTable";
import { Dot } from "./components/ui";
import type { CaseId } from "./scenarios";
import type { CoordinatorLeadership, Payment, PaymentEvent, PaymentMetrics, WorkerFault, WorkersHealthResponse } from "./types";

const TITLES: Record<DashboardSection, { title: string; subtitle: string }> = {
  home: { title: "Home", subtitle: "Distributed payment simulation overview" },
  demo: { title: "Live demo", subtitle: "Each scenario breaks one thing on purpose, then shows how the system copes" },
  payments: {
    title: "Try a payment",
    subtitle: "Run teaching cases against the live API, or send a manual payment and inspect its timeline",
  },
  status: { title: "System status", subtitle: "What is running right now, who is leader, and the switches for breaking things" },
  benchmarks: { title: "Benchmarks", subtitle: "How the system behaved when many payments were sent at once" },
};

type ClusterErrors = {
  leadership?: string;
  health?: string;
  metrics?: string;
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
  const [section, setSection] = useState<DashboardSection>("home");
  const [demoScenario, setDemoScenario] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [caseRunning, setCaseRunning] = useState(false);
  const [paymentsCaseId, setPaymentsCaseId] = useState<CaseId>("normal");
  const [teachingCaseActive, setTeachingCaseActive] = useState(false);
  const [manualPayOpen, setManualPayOpen] = useState(false);
  const [error, setError] = useState("");
  const [errorTone, setErrorTone] = useState<"error" | "warning" | "ok">("error");
  const [result, setResult] = useState<Payment | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [paymentsError, setPaymentsError] = useState("");
  const [health, setHealth] = useState<WorkersHealthResponse | null>(null);
  const [metrics, setMetrics] = useState<PaymentMetrics | null>(null);
  const [leadership, setLeadership] = useState<CoordinatorLeadership | null>(null);
  const [clusterErrors, setClusterErrors] = useState<ClusterErrors>({});
  const [clusterLoading, setClusterLoading] = useState(true);
  const [clusterLastUpdated, setClusterLastUpdated] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [paymentAmount, setPaymentAmount] = useState("25.00");
  const [paymentDescription, setPaymentDescription] = useState("Course registration fee");
  const [workerFaults, setWorkerFaults] = useState<WorkerFault[]>([]);
  const [faultsError, setFaultsError] = useState("");
  const logicalRequest = useRef<{ amount: string; description: string } | null>(null);
  const faultInjectionRef = useRef(false);

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
    const errors: ClusterErrors = {};
    const [leadershipResult, healthResult, metricsResult] = await Promise.allSettled([
      fetchCoordinatorLeadership(),
      fetchWorkerHealth(),
      fetchMetrics(),
    ]);

    if (leadershipResult.status === "fulfilled") {
      setLeadership(leadershipResult.value);
    } else {
      errors.leadership =
        leadershipResult.reason instanceof Error ? leadershipResult.reason.message : "Could not load leadership.";
    }

    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
    } else {
      errors.health = healthResult.reason instanceof Error ? healthResult.reason.message : "Could not load worker health.";
    }

    if (metricsResult.status === "fulfilled") {
      setMetrics(metricsResult.value);
      faultInjectionRef.current = metricsResult.value.fault_injection_enabled;
      if (metricsResult.value.fault_injection_enabled) {
        try {
          setWorkerFaults(await fetchFaults());
          setFaultsError("");
        } catch (faultLoadError) {
          setFaultsError(faultLoadError instanceof Error ? faultLoadError.message : "Could not load fault switches.");
        }
      } else {
        setWorkerFaults([]);
        setFaultsError("");
      }
    } else {
      errors.metrics = metricsResult.reason instanceof Error ? metricsResult.reason.message : "Could not load metrics.";
    }

    setClusterErrors(errors);
    setClusterLastUpdated(Date.now());
    setClusterLoading(false);
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

  const reloadFaults = useCallback(async () => {
    if (!faultInjectionRef.current) {
      setWorkerFaults([]);
      setFaultsError("");
      return;
    }
    try {
      setWorkerFaults(await fetchFaults());
      setFaultsError("");
    } catch (faultLoadError) {
      setFaultsError(faultLoadError instanceof Error ? faultLoadError.message : "Could not load fault switches.");
    }
  }, []);

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

  function applyCaseFeedback(payment: Payment | null, message?: string, tone: "ok" | "error" | "warning" = "ok") {
    if (payment) {
      setResult(payment);
      setSelectedId(payment.transaction_id);
    }
    if (message) {
      setErrorTone(tone);
      setError(message);
    } else {
      setError("");
    }
  }

  async function handleSubmit(amount: string, description: string): Promise<boolean> {
    if (!amount || !description) {
      setError("Enter an amount and what it is for.");
      setErrorTone("error");
      return false;
    }
    const abnormal = summarizeAbnormalFaults(workerFaults);
    if (faultInjection && abnormal) {
      setErrorTone("warning");
      setError(
        `Workers are in test mode (${abnormal}). Reset workers to Normal above, or use Run case for the selected scenario. Pay was not sent.`,
      );
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
  const leaderId = clusterErrors.leadership ? null : currentLeaderId(leadership);
  const workerFaultSummary = faultInjection ? shortFaultSummary(workerFaults) : null;
  const manualPayBlocked = faultInjection && hasAbnormalWorkerFaults(workerFaults);
  const heading = TITLES[section];
  const formDisabled = submitting || caseRunning;

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
              <Dot tone={clusterErrors.leadership ? "amber" : leaderId ? "green" : "red"} />
              {clusterErrors.leadership
                ? "Leader: unavailable"
                : leaderId
                  ? `Leader: Coordinator ${leaderId}`
                  : "No leader (election or expired lease)"}
            </p>
            <p className="flex items-center gap-2">
              <Dot tone={clusterErrors.health ? "amber" : reachableWorkers > 0 ? "green" : health ? "red" : "amber"} />
              {clusterErrors.health
                ? "Workers: unavailable"
                : `Workers reachable: ${reachableWorkers} of ${health?.workers.length ?? 0}`}
            </p>
            <p className="flex items-center gap-2">
              <Dot tone={faultInjection ? "amber" : "slate"} />
              Failure switches {clusterErrors.metrics ? "unknown" : faultInjection ? "on" : "off"}
            </p>
            {workerFaultSummary && (
              <p className="flex items-center gap-2">
                <Dot tone="amber" />
                Worker fault: {workerFaultSummary}
              </p>
            )}
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

          {section === "home" && (
            <Home leadership={leadership} health={health} onNavigate={setSection} onWatchDemo={watchScenario} />
          )}

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
              <InteractivePaymentCases
                amount={paymentAmount}
                description={paymentDescription}
                faultInjectionEnabled={faultInjection}
                workerFaults={workerFaults}
                faultsError={faultsError}
                leadership={leadership}
                health={health}
                onFaultsChange={() => void reloadFaults()}
                disabled={formDisabled}
                onPayment={applyCaseFeedback}
                onRunningChange={setCaseRunning}
                onTeachingActive={setTeachingCaseActive}
                onActiveCaseChange={(id) => {
                  setPaymentsCaseId(id);
                  if (id === "normal") {
                    setManualPayOpen(false);
                  }
                }}
                onCaseDemonstration={(demo, transactionId) => {
                  if (transactionId) {
                    setSelectedId(transactionId);
                  }
                  if (demo?.failed?.payment) {
                    setResult(demo.failed.payment);
                  } else if (demo?.unknown?.reconciledPayment) {
                    setResult(demo.unknown.reconciledPayment);
                  } else if (demo?.conflict?.firstPayment) {
                    setResult(demo.conflict.firstPayment);
                  } else if (demo?.leadership?.payment) {
                    setResult(demo.leadership.payment);
                  } else if (demo?.normal?.payment) {
                    setResult(demo.normal.payment);
                  } else if (demo?.requests?.length) {
                    setResult(demo.requests[demo.requests.length - 1].payment);
                  }
                }}
                onChanged={() => void refreshAll()}
              />
              {error && (
                <p
                  className={`rounded-xl px-4 py-3 text-sm ring-1 ${
                    errorTone === "warning"
                      ? "bg-amber-50 text-amber-950 ring-amber-200"
                      : errorTone === "ok"
                        ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
                        : "bg-rose-50 text-rose-800 ring-rose-200"
                  }`}
                  role="alert"
                >
                  {error}
                </p>
              )}
              {paymentsCaseId !== "normal" && !manualPayOpen ? (
                <div className="space-y-4">
                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700 ring-1 ring-slate-200">
                    Manual Pay is hidden while a teaching case is selected — it uses a new request ID each time and will look like a normal SUCCESS.{" "}
                    <button type="button" className="font-medium text-indigo-700 underline" onClick={() => setManualPayOpen(true)}>
                      Show manual Pay anyway
                    </button>
                  </div>
                  <ResultCard
                    payment={result}
                    loading={submitting}
                    hint="Teaching case outcome — see Case demonstration above."
                  />
                </div>
              ) : (
                <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
                  <PaymentForm
                    amount={paymentAmount}
                    description={paymentDescription}
                    disabled={formDisabled}
                    idempotencyKey={idempotencyKey}
                    workersNotNormal={manualPayBlocked}
                    onAmountChange={setPaymentAmount}
                    onDescriptionChange={setPaymentDescription}
                    onDraftChange={rotateKeyForDraft}
                    onSubmit={handleSubmit}
                  />
                  <ResultCard
                    payment={result}
                    loading={submitting}
                    hint={teachingCaseActive ? "Teaching case outcome — see Case demonstration above." : undefined}
                  />
                </div>
              )}
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
              clusterErrors={clusterErrors}
              clusterLoading={clusterLoading}
              clusterLastUpdated={clusterLastUpdated}
              onChanged={() => void refreshAll()}
            />
          )}

          {section === "benchmarks" && <Benchmarks />}
        </div>
      </main>
    </div>
  );
}
