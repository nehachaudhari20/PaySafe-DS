import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  crashLeader,
  createPayment,
  fetchCoordinatorLeadership,
  fetchElectionEvents,
  fetchPayment,
  fetchPaymentEvents,
  reconcile,
  setWorkerFault,
} from "../api";
import type { CoordinatorLeadership, ElectionEvent, Payment, PaymentEvent, WorkersHealthResponse } from "../types";
import { ElectionLog } from "./ElectionLog";
import { TimelineList } from "./ExecutionTimeline";
import { FlowDiagram, type FlowNode, type WorkerMode } from "./FlowDiagram";
import { StatusBadge } from "./StatusBadge";
import { Button, Card } from "./ui";

type StepState = "running" | "done" | "error";
type Step = { label: string; state: StepState; at: FlowNode[]; detail?: string };

type Context = {
  step: (label: string, at: FlowNode[], action: () => Promise<string | void>) => Promise<void>;
  wait: (seconds: number | (() => number), label: string, at: FlowNode[]) => Promise<void>;
  showPayment: (payment: Payment) => void;
  setCrashed: (id: number | null) => void;
  setWorkers: (mode: WorkerMode) => void;
};

export type Scenario = {
  id: string;
  title: string;
  problem: string;
  breakIt: string;
  expect: string;
  verdict: string;
  showsElection?: boolean;
  run: (ctx: Context) => Promise<void>;
};

const WORKERS = ["worker-a", "worker-b"];
const FULL_PATH: FlowNode[] = ["you", "api", "leader", "worker", "db"];
const NODE_NAMES: Record<FlowNode, string> = {
  you: "You",
  api: "Payment API",
  leader: "Coordinators",
  worker: "Workers",
  db: "Database",
};
const HOP_MS = 700;
const STEP_MIN_MS = 1500;
const AUTO_PAUSE_MS = 2000;
const CRASH_SECONDS = 45;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function key(prefix: string): string {
  return `demo-${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function setAllWorkers(mode: "normal" | "fail" | "delay", delaySeconds = 0): Promise<void> {
  await Promise.all(WORKERS.map((worker) => setWorkerFault(worker, mode, delaySeconds)));
}

async function pay(amount: string, description: string, idempotencyKey: string): Promise<Payment> {
  try {
    return await createPayment(amount, description, idempotencyKey);
  } catch (error) {
    if (error instanceof ApiError && error.payment) {
      return error.payment;
    }
    throw error;
  }
}

function outcome(payment: Payment): string {
  const attempts = `${payment.attempt_count} attempt${payment.attempt_count === 1 ? "" : "s"}`;
  switch (payment.status) {
    case "SUCCESS":
      return `Payment ${payment.transaction_id} succeeded on ${payment.worker_id ?? "a worker"} (${attempts}).`;
    case "FAILED":
      return `Payment ${payment.transaction_id} FAILED: the worker reported a decline (${attempts}).`;
    case "UNKNOWN":
      return `Payment ${payment.transaction_id} is UNKNOWN: no worker answered in time, so the system does not claim it failed (${attempts}).`;
    default:
      return `Payment ${payment.transaction_id} is ${payment.status} (${attempts}).`;
  }
}

function expectStatus(payment: Payment, status: string): void {
  if (payment.status !== status) {
    throw new Error(`Expected ${status}, got ${payment.status}. ${outcome(payment)}`);
  }
}

async function healthyWorkers(setWorkers: (mode: WorkerMode) => void): Promise<string> {
  await setAllWorkers("normal");
  setWorkers("ok");
  return "Workers A and B are working normally.";
}

export const SCENARIOS: Scenario[] = [
  {
    id: "normal",
    title: "A normal payment",
    problem: "Before breaking anything, see what a healthy payment looks like.",
    breakIt: "Nothing. This is the baseline.",
    expect: "The payment travels API → leader → one worker → database, and ends SUCCESS.",
    verdict: "The payment took the normal path and was saved exactly once.",
    run: async ({ step, showPayment, setWorkers }) => {
      await step("Make sure both workers are healthy", ["worker"], () => healthyWorkers(setWorkers));
      await step("Send a payment of 25.00", FULL_PATH, async () => {
        const payment = await pay("25.00", "Demo: normal payment", key("normal"));
        showPayment(payment);
        expectStatus(payment, "SUCCESS");
        return outcome(payment);
      });
    },
  },
  {
    id: "double",
    title: "User clicks Pay twice",
    problem: "A reply gets lost, so the app (or the user) sends the same payment again. Without protection, they would be charged twice.",
    breakIt: "Send the exact same request twice, with the same request ID (idempotency key).",
    expect: "The second request gets back the first payment. Nothing is charged twice.",
    verdict: "Two clicks, one payment. The duplicate never reached a worker.",
    run: async ({ step, showPayment, setWorkers }) => {
      const idempotencyKey = key("retry");
      let first: Payment | null = null;
      await step("Make sure both workers are healthy", ["worker"], () => healthyWorkers(setWorkers));
      await step("First click: send 40.00", FULL_PATH, async () => {
        first = await pay("40.00", "Demo: retried payment", idempotencyKey);
        showPayment(first);
        return outcome(first);
      });
      await step("Second click: send the same request again", ["you", "api", "db"], async () => {
        const second = await pay("40.00", "Demo: retried payment", idempotencyKey);
        if (!first || second.transaction_id !== first.transaction_id) {
          throw new Error(`A different payment was created: ${second.transaction_id}`);
        }
        return `Got the same payment back (${second.transaction_id}). The API found the request ID in the database and stopped there. Notice the path skipped the coordinators and workers.`;
      });
    },
  },
  {
    id: "conflict",
    title: "Same request ID, different amount",
    problem: "A buggy client reuses a request ID for a different payment. Quietly returning the old payment would hide the bug.",
    breakIt: "Reuse the request ID, but change the amount from 30.00 to 99.00.",
    expect: "The API refuses the second request (HTTP 409) and the original payment stays unchanged.",
    verdict: "Reusing a request ID with different data is caught and refused.",
    run: async ({ step, showPayment, setWorkers }) => {
      const idempotencyKey = key("conflict");
      await step("Make sure both workers are healthy", ["worker"], () => healthyWorkers(setWorkers));
      await step("Send 30.00 with a new request ID", FULL_PATH, async () => {
        const payment = await pay("30.00", "Demo: original payload", idempotencyKey);
        showPayment(payment);
        return outcome(payment);
      });
      await step("Send 99.00 with the same request ID", ["you", "api", "db"], async () => {
        try {
          await createPayment("99.00", "Demo: original payload", idempotencyKey);
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            return `Refused with HTTP 409: "${error.message}" The 99.00 payment was never created.`;
          }
          throw error;
        }
        throw new Error("The API accepted it, but it should have refused.");
      });
    },
  },
  {
    id: "failed",
    title: "The worker declines",
    problem: "Some payments really fail, like a bank decline. The system has to report that honestly.",
    breakIt: "Switch both workers to always decline.",
    expect: "The worker says no. A clear decline is final, so it is not retried, and the payment ends FAILED.",
    verdict: "FAILED is used only when a worker actually reports a failure, unlike the next scenario where nobody knows.",
    run: async ({ step, showPayment, setWorkers }) => {
      await step("Break it: switch both workers to always decline", ["worker"], async () => {
        await setAllWorkers("fail");
        setWorkers("fail");
        return "Workers A and B will now decline every payment. They are marked red in the diagram.";
      });
      try {
        await step("Send a payment of 12.00", FULL_PATH, async () => {
          const payment = await pay("12.00", "Demo: worker failure", key("fail"));
          showPayment(payment);
          expectStatus(payment, "FAILED");
          return outcome(payment);
        });
      } finally {
        await step("Repair: switch the workers back to normal", ["worker"], () => healthyWorkers(setWorkers));
      }
    },
  },
  {
    id: "unknown",
    title: "The worker is too slow",
    problem:
      "A worker may finish the payment but answer too late. Nobody knows if money moved. Calling it FAILED could be wrong, and blindly retrying could charge twice.",
    breakIt: "Slow both workers to 8 seconds. The coordinator only waits 5.",
    expect:
      "The payment is marked UNKNOWN, not FAILED. Later, reconciliation reads what the worker actually did and corrects it to SUCCESS, without running it again.",
    verdict: "The uncertain result was reported honestly, then fixed from evidence. Nothing ran twice.",
    run: async ({ step, wait, showPayment, setWorkers }) => {
      let payment: Payment | null = null;
      await step("Break it: slow both workers to 8 seconds", ["worker"], async () => {
        await setAllWorkers("delay", 8);
        setWorkers("slow");
        return "Workers will now finish after the coordinator has stopped waiting. They are marked in the diagram.";
      });
      try {
        await step("Send a payment of 33.00 (takes about 10 seconds)", FULL_PATH, async () => {
          payment = await pay("33.00", "Demo: slow worker", key("slow"));
          showPayment(payment);
          expectStatus(payment, "UNKNOWN");
          return `${outcome(payment)} On the retry, the second worker saw the payment was already taken and did not run it again.`;
        });
      } finally {
        await step("Repair: switch the workers back to normal", ["worker"], () => healthyWorkers(setWorkers));
      }
      await wait(10, "Give the slow worker time to finish and save its result", ["worker", "db"]);
      await step("Run reconciliation: look up what the worker actually did", ["api", "db"], async () => {
        const result = await reconcile();
        return `Reconciliation settled ${result.resolved.length} payment(s) from the result the worker saved. It did not call any worker.`;
      });
      await step("Check the payment again", ["api", "db"], async () => {
        if (!payment) {
          throw new Error("There is no payment to check.");
        }
        const latest = await fetchPayment(payment.transaction_id);
        showPayment(latest);
        expectStatus(latest, "SUCCESS");
        return `${outcome(latest)} It went from UNKNOWN to SUCCESS.`;
      });
    },
  },
  {
    id: "leader",
    title: "The leader crashes",
    problem: "Only the leader coordinator gives out work. If it dies and nobody takes over, payments stop.",
    breakIt: `Crash the current leader for ${CRASH_SECONDS} seconds. It stops talking to the other coordinators.`,
    expect:
      "The other two notice its heartbeats have stopped and hold an election (highest surviving ID wins). The new leader gets a higher term number, and a payment sent meanwhile still succeeds.",
    verdict: "Payments kept working through a leader crash, and there was never more than one leader.",
    showsElection: true,
    run: async ({ step, wait, showPayment, setCrashed, setWorkers }) => {
      let before: CoordinatorLeadership | null = null;
      let crashedAt = 0;
      await step("Make sure both workers are healthy", ["worker"], () => healthyWorkers(setWorkers));
      await step("See who is leader now", ["leader"], async () => {
        before = await fetchCoordinatorLeadership();
        if (before.leader_id == null) {
          throw new Error("No leader has been elected yet. Wait a few seconds and run again.");
        }
        return `Coordinator ${before.leader_id} is the leader (term ${before.term}). It has the green “leader” tag.`;
      });
      await step(`Break it: crash the leader for ${CRASH_SECONDS} seconds`, ["leader"], async () => {
        const result = await crashLeader(CRASH_SECONDS);
        crashedAt = Date.now();
        setCrashed(result.crashed_leader_id);
        return `Coordinator ${result.crashed_leader_id} stopped sending heartbeats and ignores everyone. Its lease runs out in about 5 seconds and the others start an election.`;
      });
      await step("Send a payment of 55.00 while the leader is down", FULL_PATH, async () => {
        const payment = await pay("55.00", "Demo: payment during failover", key("failover"));
        showPayment(payment);
        expectStatus(payment, "SUCCESS");
        return `${outcome(payment)} The API waited until a new leader was elected, then sent it there.`;
      });
      await step("See who leads now", ["leader"], async () => {
        const after = await fetchCoordinatorLeadership();
        if (!before || after.leader_id === before.leader_id || (after.term ?? 0) <= (before.term ?? 0)) {
          throw new Error(`Leadership did not change (leader ${after.leader_id}, term ${after.term}).`);
        }
        return `Coordinator ${after.leader_id} won the election: term ${after.term}, up from ${before.term}. Even if the old leader wakes up, its old term no longer allows it to give out work.`;
      });
      await wait(
        () => Math.max(3, Math.ceil(CRASH_SECONDS - (Date.now() - crashedAt) / 1000) + 4),
        "Wait for the crashed coordinator to come back",
        ["leader"],
      );
      setCrashed(null);
      await step("Check that the old leader rejoined", ["leader"], async () => {
        const crashed = (before as CoordinatorLeadership | null)?.leader_id;
        const [after, log] = await Promise.all([fetchCoordinatorLeadership(), fetchElectionEvents(80)]);
        const rejoined = log.some((event) => event.coordinator_id === crashed && event.message.includes("rejoin-after-crash"));
        if (!rejoined) {
          throw new Error(`Coordinator ${crashed} has not rejoined yet.`);
        }
        return after.leader_id === crashed
          ? `Coordinator ${crashed} came back and became leader again at term ${after.term}.`
          : `Coordinator ${crashed} came back, saw that Coordinator ${after.leader_id} already holds a valid leadership, and joined as a follower.`;
      });
    },
  },
];

class Stopped extends Error {}

type Upcoming = { label: string; at: FlowNode[]; number: number };

export function DemoScenarios({
  leadership,
  health,
  faultInjectionEnabled,
  initialId,
  onChanged,
}: {
  leadership: CoordinatorLeadership | null;
  health: WorkersHealthResponse | null;
  faultInjectionEnabled: boolean;
  initialId?: string;
  onChanged: () => void;
}) {
  const [activeId, setActiveId] = useState(initialId ?? SCENARIOS[0].id);
  const [running, setRunning] = useState(false);
  const [auto, setAuto] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [upcoming, setUpcoming] = useState<Upcoming | null>(null);
  const [finished, setFinished] = useState<"ok" | "error" | "stopped" | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [events, setEvents] = useState<PaymentEvent[]>([]);
  const [electionEvents, setElectionEvents] = useState<ElectionEvent[]>([]);
  const [crashedId, setCrashedId] = useState<number | null>(null);
  const [workerMode, setWorkerMode] = useState<WorkerMode>("ok");
  const [hop, setHop] = useState(0);
  const paymentRef = useRef<Payment | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const autoRef = useRef(false);
  const stoppedRef = useRef(false);
  const gateRef = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scenario = SCENARIOS.find((item) => item.id === activeId) ?? SCENARIOS[0];
  const current = steps.find((item) => item.state === "running");
  const lastDone = [...steps].reverse().find((item) => item.state !== "running");

  useEffect(() => {
    if (initialId) {
      setActiveId(initialId);
    }
  }, [initialId]);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = window.setInterval(() => void refreshTraces(), 1500);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(
    () => () => {
      stoppedRef.current = true;
      gateRef.current?.reject(new Stopped("Stopped."));
      gateRef.current = null;
    },
    [],
  );

  useEffect(() => {
    setHop(0);
    if (!current || current.at.length < 2) {
      return;
    }
    const timer = window.setInterval(() => setHop((value) => value + 1), HOP_MS);
    return () => window.clearInterval(timer);
  }, [current?.label]);

  async function refreshTraces() {
    const latest = paymentRef.current;
    if (latest) {
      try {
        setEvents(await fetchPaymentEvents(latest.transaction_id));
      } catch {
        /* keep the last trace */
      }
    }
    try {
      const all = await fetchElectionEvents(80);
      const since = startedAtRef.current;
      setElectionEvents(since ? all.filter((event) => new Date(event.created_at).getTime() >= since - 2000) : all);
    } catch {
      /* the log is optional */
    }
    onChanged();
  }

  function reset() {
    setSteps([]);
    setFinished(null);
    setUpcoming(null);
    setPayment(null);
    setEvents([]);
    setElectionEvents([]);
    paymentRef.current = null;
  }

  function update(index: number, patch: Partial<Step>) {
    setSteps((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function next() {
    gateRef.current?.resolve();
    gateRef.current = null;
  }

  function playRest() {
    autoRef.current = true;
    setAuto(true);
    next();
  }

  function stop() {
    stoppedRef.current = true;
    gateRef.current?.reject(new Stopped("Stopped."));
    gateRef.current = null;
  }

  async function run(startAuto: boolean) {
    reset();
    setRunning(true);
    setAuto(startAuto);
    autoRef.current = startAuto;
    stoppedRef.current = false;
    startedAtRef.current = Date.now();
    stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    let index = -1;
    let failed = false;

    async function gate(label: string, at: FlowNode[]) {
      if (stoppedRef.current) {
        throw new Stopped("Stopped.");
      }
      setUpcoming({ label, at, number: index + 2 });
      if (autoRef.current) {
        await sleep(AUTO_PAUSE_MS);
      } else {
        await new Promise<void>((resolve, reject) => {
          gateRef.current = { resolve, reject };
        });
      }
      setUpcoming(null);
      if (stoppedRef.current) {
        throw new Stopped("Stopped.");
      }
    }

    const ctx: Context = {
      step: async (label, at, action) => {
        await gate(label, at);
        index += 1;
        const mine = index;
        setSteps((list) => [...list, { label, at, state: "running" }]);
        const minimum = Math.max(STEP_MIN_MS, at.length > 1 ? at.length * HOP_MS + 200 : 0);
        const started = Date.now();
        try {
          const detail = await action();
          await sleep(Math.max(0, minimum - (Date.now() - started)));
          update(mine, { state: "done", detail: detail || undefined });
        } catch (error) {
          failed = true;
          update(mine, { state: "error", detail: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
      wait: async (seconds, label, at) => {
        await gate(label, at);
        index += 1;
        const mine = index;
        const total = typeof seconds === "function" ? seconds() : seconds;
        setSteps((list) => [...list, { label, at, state: "running", detail: `${total}s left` }]);
        for (let left = total; left > 0; left -= 1) {
          if (stoppedRef.current) {
            throw new Stopped("Stopped.");
          }
          update(mine, { detail: `${left}s left` });
          await sleep(1000);
        }
        update(mine, { state: "done", detail: `Waited ${total}s.` });
      },
      showPayment: (nextPayment) => {
        paymentRef.current = nextPayment;
        setPayment(nextPayment);
      },
      setCrashed: setCrashedId,
      setWorkers: setWorkerMode,
    };

    let stopped = false;
    try {
      await scenario.run(ctx);
    } catch (error) {
      if (error instanceof Stopped) {
        stopped = true;
      } else {
        failed = true;
      }
    } finally {
      setUpcoming(null);
      await setAllWorkers("normal").catch(() => undefined);
      setWorkerMode("ok");
      setCrashedId(null);
      await refreshTraces();
      setFinished(stopped ? "stopped" : failed ? "error" : "ok");
      setRunning(false);
    }
  }

  const movingNode = current && current.at.length > 1 ? current.at[hop % current.at.length] : null;
  const activeNodes = current ? (movingNode ? [movingNode] : current.at) : [];

  return (
    <div className="space-y-5">
      {!faultInjectionEnabled && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          The failure switches are turned off. Start the stack with FAULT_INJECTION_ENABLED=true to run these scenarios.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
        <nav className="space-y-1.5" aria-label="Scenarios">
          <p className="px-1 pb-1 text-xs font-medium text-slate-500">1. Pick a scenario</p>
          {SCENARIOS.map((item, number) => {
            const selected = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                disabled={running}
                onClick={() => {
                  setActiveId(item.id);
                  reset();
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected ? "bg-indigo-600 text-white shadow-sm disabled:opacity-100" : "bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-indigo-300"
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    selected ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {number + 1}
                </span>
                <span className="text-sm font-medium">{item.title}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 space-y-5">
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">{scenario.title}</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <StoryBox label="The problem" tone="slate" text={scenario.problem} />
              <StoryBox label="What we break" tone="rose" text={scenario.breakIt} />
              <StoryBox label="What should happen" tone="emerald" text={scenario.expect} />
            </div>
          </Card>

          <div ref={stageRef} className="scroll-mt-4 rounded-2xl bg-white p-5 ring-1 ring-slate-200/70">
            <Caption
              running={running}
              upcoming={upcoming}
              current={current}
              lastDone={lastDone}
              finished={finished}
              verdict={scenario.verdict}
              auto={auto}
              disabled={!faultInjectionEnabled}
              onStartStep={() => void run(false)}
              onStartAuto={() => void run(true)}
              onNext={next}
              onPlayRest={playRest}
              onStop={stop}
            />
            <div className="mt-5">
              <FlowDiagram
                leadership={leadership}
                health={health}
                active={activeNodes}
                upcoming={upcoming?.at ?? []}
                crashedId={crashedId}
                workerMode={workerMode}
              />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              <span className="font-semibold text-indigo-700">Blue</span> = where the current step is happening (a payment moves box to box).{" "}
              <span className="font-semibold text-rose-700">Red</span> = broken on purpose. Dashed = where the next step will happen.
            </p>
          </div>

          <Card title="All steps so far">
            {steps.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing yet. Steps and their results will be listed here.</p>
            ) : (
              <ol className="space-y-3">
                {steps.map((item, i) => (
                  <li key={i} className="flex gap-3">
                    <StepIcon state={item.state} number={i + 1} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-900">
                        {item.label}
                        <span className="ml-2 text-xs font-normal text-slate-400">at {item.at.map((node) => NODE_NAMES[node]).join(" → ")}</span>
                      </p>
                      {item.detail && (
                        <p className={`mt-0.5 text-sm ${item.state === "error" ? "text-rose-700" : "text-slate-600"}`}>{item.detail}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {(payment || electionEvents.length > 0) && (
            <details className="group rounded-2xl bg-white p-5 ring-1 ring-slate-200/70">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-slate-900">
                <span>Technical details: the system’s own records</span>
                <span className="text-xs font-medium text-indigo-600 group-open:hidden">Show</span>
                <span className="hidden text-xs font-medium text-indigo-600 group-open:inline">Hide</span>
              </summary>
              <div className={`mt-4 grid gap-5 ${scenario.showsElection ? "xl:grid-cols-2" : ""}`}>
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-700">Payment log {payment ? `· ${payment.transaction_id}` : ""}</p>
                    {payment && <StatusBadge status={payment.status} />}
                  </div>
                  <p className="mb-3 text-xs text-slate-500">
                    Every step the API, coordinator and worker recorded. “L” numbers are logical clock values that keep the steps in true order.
                  </p>
                  {events.length > 0 ? <TimelineList events={events} /> : <p className="text-sm text-slate-500">No records yet.</p>}
                </div>
                {scenario.showsElection && (
                  <div>
                    <p className="mb-2 text-sm font-medium text-slate-700">Election messages between coordinators</p>
                    <ElectionLog events={electionEvents} emptyText="Messages appear once the leader stops." />
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function Caption({
  running,
  upcoming,
  current,
  lastDone,
  finished,
  verdict,
  auto,
  disabled,
  onStartStep,
  onStartAuto,
  onNext,
  onPlayRest,
  onStop,
}: {
  running: boolean;
  upcoming: Upcoming | null;
  current?: Step;
  lastDone?: Step;
  finished: "ok" | "error" | "stopped" | null;
  verdict: string;
  auto: boolean;
  disabled: boolean;
  onStartStep: () => void;
  onStartAuto: () => void;
  onNext: () => void;
  onPlayRest: () => void;
  onStop: () => void;
}) {
  const previous =
    lastDone && lastDone.detail ? (
      <p className={`text-sm ${lastDone.state === "error" ? "text-rose-700" : "text-emerald-800"}`}>
        {lastDone.state === "error" ? "✗ " : "✓ "}
        <span className="font-medium">{lastDone.label}:</span> {lastDone.detail}
      </p>
    ) : null;

  if (!running) {
    return (
      <div className="space-y-3">
        {finished === "ok" && (
          <div className="rounded-xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200">
            <p className="text-base font-semibold text-emerald-900">✓ Handled correctly</p>
            <p className="mt-0.5 text-sm text-emerald-800">{verdict}</p>
          </div>
        )}
        {finished === "error" && (
          <div className="rounded-xl bg-rose-50 px-4 py-3 ring-1 ring-rose-200">
            <p className="text-base font-semibold text-rose-900">Did not go as expected</p>
            <p className="mt-0.5 text-sm text-rose-800">See the red step below for what happened instead.</p>
          </div>
        )}
        {finished === "stopped" && <p className="text-sm text-slate-600">Stopped. The workers were switched back to normal.</p>}
        <div>
          <p className="text-xs font-medium text-slate-500">2. Start it</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={onStartStep} disabled={disabled}>
              {finished ? "Run again, step by step" : "Start, one step at a time"}
            </Button>
            <Button onClick={onStartAuto} disabled={disabled}>
              Play automatically
            </Button>
          </div>
          {!finished && (
            <p className="mt-2 text-sm text-slate-500">
              Step by step is best for presenting: you press <b>Next step</b> each time, and can explain what is on screen before moving on.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {previous && <div className="rounded-xl bg-emerald-50/60 px-4 py-2.5 ring-1 ring-emerald-100">{previous}</div>}
      {upcoming && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-indigo-50 px-4 py-3 ring-1 ring-indigo-200">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Next: step {upcoming.number}</p>
            <p className="text-base font-semibold text-slate-900">{upcoming.label}</p>
            <p className="text-xs text-slate-500">Will happen at: {upcoming.at.map((node) => NODE_NAMES[node]).join(" → ")}</p>
          </div>
          {auto ? (
            <p className="text-sm text-indigo-700">Starting in a moment…</p>
          ) : (
            <div className="flex gap-2">
              <Button variant="primary" onClick={onNext}>
                Next step →
              </Button>
              <Button onClick={onPlayRest}>Play the rest</Button>
            </div>
          )}
        </div>
      )}
      {current && (
        <div className="flex items-center gap-3 rounded-xl bg-indigo-600 px-4 py-3 text-white">
          <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <div>
            <p className="text-base font-semibold">{current.label}</p>
            <p className="text-xs text-indigo-100">
              {current.detail ?? `Happening at: ${current.at.map((node) => NODE_NAMES[node]).join(" → ")}`}
            </p>
          </div>
        </div>
      )}
      <div className="text-right">
        <button type="button" onClick={onStop} className="text-xs font-medium text-slate-400 hover:text-rose-600">
          Stop this scenario
        </button>
      </div>
    </div>
  );
}

function StoryBox({ label, text, tone }: { label: string; text: string; tone: "slate" | "rose" | "emerald" }) {
  const styles = {
    slate: ["bg-slate-50", "text-slate-500"],
    rose: ["bg-rose-50", "text-rose-600"],
    emerald: ["bg-emerald-50", "text-emerald-700"],
  }[tone];
  return (
    <div className={`rounded-xl p-3 ${styles[0]}`}>
      <p className={`text-xs font-semibold uppercase tracking-wide ${styles[1]}`}>{label}</p>
      <p className="mt-1 text-sm text-slate-700">{text}</p>
    </div>
  );
}

function StepIcon({ state, number }: { state: StepState; number: number }) {
  if (state === "running") {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
      </span>
    );
  }
  const styles = state === "done" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700";
  return (
    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${styles}`}>
      {state === "done" ? "✓" : state === "error" ? "!" : number}
    </span>
  );
}
