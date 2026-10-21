import {
  ApiError,
  crashLeader,
  createPayment,
  createPaymentWithMeta,
  fetchCoordinatorLeadership,
  fetchElectionEvents,
  fetchPayment,
  fetchPaymentEvents,
  reconcile,
  setWorkerFault,
} from "../api";
import type { CoordinatorLeadership, Payment, PaymentEvent } from "../types";
import type { FlowNode, WorkerMode } from "../components/FlowDiagram";
import {
  dispatchEventCount,
  hasIdempotencyReplay,
  type CaseDemonstration,
  type CaseRequestRecord,
} from "./demonstration";
import { getCaseDefinition } from "./definitions";
import type { CaseId, CaseInput, CaseRunHooks, CaseRunResult } from "./types";

const GRPC_TIMEOUT_SECONDS = 5;
export const DOUBLE_RETRY_PAUSE_MS = 2500;

const FULL_PATH: FlowNode[] = ["you", "api", "leader", "worker", "db"];
const REPLAY_PATH: FlowNode[] = ["you", "api", "db"];
const CONFLICT_REJECT_PATH: FlowNode[] = ["you", "api"];

export const WORKERS = ["worker-a", "worker-b"];
export const CRASH_SECONDS = 45;
export const WORKER_DELAY_SECONDS = 8;

const DEMO_AMOUNTS: Record<CaseId, { amount: string; description: string }> = {
  normal: { amount: "25.00", description: "Demo: normal payment" },
  double: { amount: "40.00", description: "Demo: retried payment" },
  conflict: { amount: "30.00", description: "Demo: original payload" },
  failed: { amount: "12.00", description: "Demo: worker failure" },
  unknown: { amount: "33.00", description: "Demo: slow worker" },
  leader: { amount: "55.00", description: "Demo: payment during failover" },
};

export function scenarioKey(prefix: string): string {
  return `demo-${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function conflictAlternateAmount(amount: string): string {
  const normalized = amount.trim();
  return normalized === "99.00" ? "88.00" : "99.00";
}

export async function setAllWorkers(mode: "normal" | "fail" | "delay", delaySeconds = 0): Promise<void> {
  await Promise.all(WORKERS.map((worker) => setWorkerFault(worker, mode, delaySeconds)));
}

export async function restoreAllWorkers(setWorkers?: (mode: WorkerMode) => void): Promise<void> {
  await setAllWorkers("normal");
  setWorkers?.("ok");
}

export async function pay(amount: string, description: string, idempotencyKey: string): Promise<Payment> {
  try {
    return await createPayment(amount, description, idempotencyKey);
  } catch (error) {
    if (error instanceof ApiError && error.payment) {
      return error.payment;
    }
    throw error;
  }
}

async function payWithMeta(amount: string, description: string, idempotencyKey: string) {
  try {
    return await createPaymentWithMeta(amount, description, idempotencyKey);
  } catch (error) {
    if (error instanceof ApiError && error.payment) {
      return { payment: error.payment, idempotencyOutcome: null };
    }
    throw error;
  }
}

function flowStep(hooks: CaseRunHooks, label: string, activeNodes: FlowNode[], phase?: string): void {
  hooks.onFlowStep?.(label, activeNodes, phase);
}

async function waitGuided(hooks: CaseRunHooks, stepId: string): Promise<void> {
  if (hooks.runMode === "guided" && hooks.waitForGuidedStep) {
    await hooks.waitForGuidedStep(stepId);
  }
}

async function pauseBeforeDuplicate(hooks: CaseRunHooks, message: string): Promise<void> {
  throwIfAborted(hooks.signal);
  if (hooks.runMode === "guided") {
    await waitGuided(hooks, "double-second");
    return;
  }
  progress(hooks, "Simulating a lost reply (user may click Pay again)…");
  if (hooks.onInterruption) {
    await hooks.onInterruption(message);
    return;
  }
  await sleep(DOUBLE_RETRY_PAUSE_MS);
}

export function paymentOutcome(payment: Payment): string {
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

export function expectStatus(payment: Payment, status: string): void {
  if (payment.status !== status) {
    throw new Error(`Expected ${status}, got ${payment.status}. ${paymentOutcome(payment)}`);
  }
}

function resolveInput(caseId: CaseId, input: CaseInput, useDemoAmounts?: boolean): CaseInput {
  if (useDemoAmounts) {
    return DEMO_AMOUNTS[caseId];
  }
  return { amount: input.amount.trim(), description: input.description.trim() };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Stopped.");
  }
}

function progress(hooks: CaseRunHooks, label: string, detail?: string): void {
  hooks.onProgress?.(label, detail);
}

function showPayment(hooks: CaseRunHooks, payment: Payment): void {
  hooks.onPayment?.(payment);
}

function publishDemo(hooks: CaseRunHooks, demonstration: CaseDemonstration): void {
  hooks.onDemonstration?.(demonstration);
}

async function loadEvents(transactionId: string): Promise<PaymentEvent[]> {
  return fetchPaymentEvents(transactionId);
}

function requestRecord(
  label: string,
  idempotencyKey: string,
  amount: string,
  description: string,
  payment: Payment,
  events: PaymentEvent[],
  extra?: { flowPath?: FlowNode[]; idempotencyOutcome?: CaseRequestRecord["idempotencyOutcome"] },
): CaseRequestRecord {
  return {
    label,
    idempotencyKey,
    amount,
    description,
    payment,
    events,
    dispatchEventCount: dispatchEventCount(events),
    flowPath: extra?.flowPath,
    idempotencyOutcome: extra?.idempotencyOutcome,
  };
}

async function healthyWorkers(hooks: CaseRunHooks): Promise<string> {
  await setAllWorkers("normal");
  hooks.setWorkers?.("ok");
  return "Workers A and B are working normally.";
}

export async function healthyWorkersForDemo(setWorkers: (mode: WorkerMode) => void): Promise<string> {
  await setAllWorkers("normal");
  setWorkers("ok");
  return "Workers A and B are working normally.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function runCase(caseId: CaseId, input: CaseInput, hooks: CaseRunHooks = {}): Promise<CaseRunResult> {
  const payload = resolveInput(caseId, input, hooks.useDemoAmounts);
  let payment: Payment | null = null;
  let result: CaseRunResult = { ok: false, payment: null };
  let demonstration: CaseDemonstration = { caseId, narrative: [] };

  try {
    switch (caseId) {
      case "normal": {
        progress(hooks, "Make sure both workers are healthy");
        await healthyWorkers(hooks);
        throwIfAborted(hooks.signal);
        progress(hooks, "Send payment with a new idempotency key");
        flowStep(hooks, "Send payment with a new idempotency key", FULL_PATH);
        payment = await pay(payload.amount, payload.description, scenarioKey("normal"));
        const events = await loadEvents(payment.transaction_id);
        showPayment(hooks, payment);
        expectStatus(payment, "SUCCESS");
        demonstration = {
          caseId,
          normal: { payment, events },
          narrative: [
            "A new payment row was stored, then the API dispatched to the elected coordinator.",
            "The coordinator selected a reachable worker and recorded attempt events.",
            `Final status is SUCCESS on ${payment.worker_id ?? "a worker"}.`,
          ],
        };
        publishDemo(hooks, demonstration);
        result = { ok: true, payment, message: paymentOutcome(payment), demonstration };
        break;
      }
      case "double": {
        const idempotencyKey = scenarioKey("retry");
        progress(hooks, "Make sure both workers are healthy");
        await healthyWorkers(hooks);
        throwIfAborted(hooks.signal);
        await waitGuided(hooks, "double-first");
        progress(hooks, "Request #1 — original submission");
        flowStep(hooks, "Request #1 — original submission", FULL_PATH, "double-first");
        const firstMeta = await payWithMeta(payload.amount, payload.description, idempotencyKey);
        const first = firstMeta.payment;
        const eventsAfterFirst = await loadEvents(first.transaction_id);
        showPayment(hooks, first);
        payment = first;
        publishDemo(hooks, {
          caseId,
          requests: [
            requestRecord("Request #1 — original submission", idempotencyKey, payload.amount, payload.description, first, eventsAfterFirst, {
              flowPath: FULL_PATH,
              idempotencyOutcome: firstMeta.idempotencyOutcome ?? "created",
            }),
          ],
          narrative: ["First request reached a worker and completed."],
        });
        await pauseBeforeDuplicate(
          hooks,
          "The first payment already finished, but the user clicks Pay again with the same request ID and payload.",
        );
        progress(hooks, "Request #2 — duplicate submission (same key and payload)");
        flowStep(hooks, "Request #2 — duplicate submission", REPLAY_PATH, "double-second");
        const secondMeta = await payWithMeta(payload.amount, payload.description, idempotencyKey);
        const second = secondMeta.payment;
        const eventsAfterSecond = await loadEvents(second.transaction_id);
        if (second.transaction_id !== first.transaction_id) {
          throw new Error(`A different payment was created: ${second.transaction_id}`);
        }
        const replayed = hasIdempotencyReplay(eventsAfterSecond) || secondMeta.idempotencyOutcome === "replayed";
        const dispatchBefore = dispatchEventCount(eventsAfterFirst);
        const dispatchAfter = dispatchEventCount(eventsAfterSecond);
        demonstration = {
          caseId,
          requests: [
            requestRecord("Request #1 — original submission", idempotencyKey, payload.amount, payload.description, first, eventsAfterFirst, {
              flowPath: FULL_PATH,
              idempotencyOutcome: firstMeta.idempotencyOutcome ?? "created",
            }),
            requestRecord("Request #2 — duplicate submission", idempotencyKey, payload.amount, payload.description, second, eventsAfterSecond, {
              flowPath: REPLAY_PATH,
              idempotencyOutcome: secondMeta.idempotencyOutcome ?? "replayed",
            }),
          ],
          narrative: [
            `Both responses share transaction ${second.transaction_id}.`,
            replayed
              ? "The API recorded IDEMPOTENCY_REPLAYED on the second call and did not dispatch again."
              : "No new worker dispatch events appeared after the duplicate (same stored payment returned).",
            `Path for request #2 skipped coordinator and worker (API → stored payment only).`,
            `Worker dispatch steps in timeline: ${dispatchBefore} after request #1, ${dispatchAfter} after request #2.`,
          ],
        };
        publishDemo(hooks, demonstration);
        result = {
          ok: true,
          payment: second,
          message: `Same transaction ${second.transaction_id} returned twice. The duplicate did not create a second payment effect.`,
          demonstration,
        };
        break;
      }
      case "conflict": {
        const idempotencyKey = scenarioKey("conflict");
        const alternate = conflictAlternateAmount(payload.amount);
        progress(hooks, "Make sure both workers are healthy");
        await healthyWorkers(hooks);
        throwIfAborted(hooks.signal);
        await waitGuided(hooks, "conflict-first");
        progress(hooks, `Request #1 — ${payload.amount} with a new idempotency key`);
        flowStep(hooks, `Request #1 — ${payload.amount}`, FULL_PATH, "conflict-first");
        payment = await pay(payload.amount, payload.description, idempotencyKey);
        const firstEvents = await loadEvents(payment.transaction_id);
        showPayment(hooks, payment);
        publishDemo(hooks, {
          caseId,
          conflict: {
            idempotencyKey,
            firstAmount: payload.amount,
            secondAmount: alternate,
            description: payload.description,
            firstPayment: payment,
            firstEvents,
            httpStatus: 0,
            httpMessage: "",
            firstFlowPath: FULL_PATH,
            secondFlowPath: CONFLICT_REJECT_PATH,
          },
          narrative: [`First payment ${payment.transaction_id} stored with amount ${payment.amount}.`],
        });
        await waitGuided(hooks, "conflict-second");
        throwIfAborted(hooks.signal);
        progress(hooks, `Request #2 — ${alternate} with the same idempotency key (conflicting payload)`);
        flowStep(hooks, `Request #2 — ${alternate} rejected`, CONFLICT_REJECT_PATH, "conflict-second");
        let httpStatus = 0;
        let httpMessage = "";
        try {
          await createPayment(alternate, payload.description, idempotencyKey);
          throw new Error("The API accepted it, but it should have refused.");
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            httpStatus = 409;
            httpMessage = error.message;
            const firstEventsAfter = await loadEvents(payment.transaction_id);
            demonstration = {
              caseId,
              conflict: {
                idempotencyKey,
                firstAmount: payload.amount,
                secondAmount: alternate,
                description: payload.description,
                firstPayment: payment,
                firstEvents: firstEventsAfter,
                httpStatus,
                httpMessage,
                firstFlowPath: FULL_PATH,
                secondFlowPath: CONFLICT_REJECT_PATH,
              },
              narrative: [
                `Original payment ${payment.transaction_id} kept amount ${payment.amount}.`,
                `Conflicting reuse returned HTTP ${httpStatus} and did not create a second payment.`,
                "IDEMPOTENCY_PAYLOAD_CONFLICT was recorded on the original payment when the API refused the reuse.",
              ],
            };
            publishDemo(hooks, demonstration);
            result = {
              ok: true,
              payment,
              conflict409: true,
              message: `Refused with HTTP 409: "${error.message}" The ${alternate} payment was never created.`,
              demonstration,
            };
            break;
          }
          throw error;
        }
        break;
      }
      case "failed": {
        progress(hooks, "Switch both workers to decline (simulated processing failure)");
        await setAllWorkers("fail");
        hooks.setWorkers?.("fail");
        try {
          throwIfAborted(hooks.signal);
          progress(hooks, "Send payment while workers are set to decline");
          flowStep(hooks, "Send payment while workers decline", FULL_PATH);
          payment = await pay(payload.amount, payload.description, scenarioKey("fail"));
          const events = await loadEvents(payment.transaction_id);
          showPayment(hooks, payment);
          expectStatus(payment, "FAILED");
          demonstration = {
            caseId,
            failed: { workerMode: "fail (both workers)", payment, events },
            narrative: [
              "Workers were reachable but configured to return a simulated processing failure.",
              "The coordinator recorded the worker result; the payment ended FAILED (not UNKNOWN).",
            ],
          };
          publishDemo(hooks, demonstration);
          result = { ok: true, payment, message: paymentOutcome(payment), demonstration };
        } finally {
          progress(hooks, "Restore workers to normal");
          await healthyWorkers(hooks);
        }
        break;
      }
      case "unknown": {
        progress(hooks, `Slow both workers to ${WORKER_DELAY_SECONDS}s (coordinator RPC timeout is ${GRPC_TIMEOUT_SECONDS}s)`);
        await setAllWorkers("delay", WORKER_DELAY_SECONDS);
        hooks.setWorkers?.("slow");
        let uncertainEvents: PaymentEvent[] = [];
        try {
          throwIfAborted(hooks.signal);
          progress(hooks, "Send payment (may take ~10 seconds)");
          flowStep(hooks, "Send payment to slow worker", FULL_PATH);
          payment = await pay(payload.amount, payload.description, scenarioKey("slow"));
          uncertainEvents = await loadEvents(payment.transaction_id);
          showPayment(hooks, payment);
          expectStatus(payment, "UNKNOWN");
          publishDemo(hooks, {
            caseId,
            unknown: {
              uncertainPayment: payment,
              uncertainEvents,
              reconciledPayment: payment,
              reconciledEvents: uncertainEvents,
              workerDelaySeconds: WORKER_DELAY_SECONDS,
              rpcTimeoutSeconds: GRPC_TIMEOUT_SECONDS,
            },
            narrative: ["Deadline passed before a confirmed worker result; status is UNKNOWN, not FAILED."],
          });
        } finally {
          progress(hooks, "Restore workers to normal");
          await healthyWorkers(hooks);
        }
        throwIfAborted(hooks.signal);
        progress(hooks, "Wait for slow worker to finish saving its effect");
        for (let left = 10; left > 0; left -= 1) {
          throwIfAborted(hooks.signal);
          await sleep(1000);
        }
        throwIfAborted(hooks.signal);
        progress(hooks, "Run reconciliation");
        const reconcileOutcome = await reconcile();
        throwIfAborted(hooks.signal);
        progress(hooks, "Check payment after reconciliation");
        if (!payment) {
          throw new Error("There is no payment to check.");
        }
        const latest = await fetchPayment(payment.transaction_id);
        const reconciledEvents = await loadEvents(payment.transaction_id);
        showPayment(hooks, latest);
        expectStatus(latest, "SUCCESS");
        demonstration = {
          caseId,
          unknown: {
            uncertainPayment: payment,
            uncertainEvents,
            reconciledPayment: latest,
            reconciledEvents,
            workerDelaySeconds: WORKER_DELAY_SECONDS,
            rpcTimeoutSeconds: GRPC_TIMEOUT_SECONDS,
          },
          narrative: [
            "After timeout the payment stayed UNKNOWN because the outcome was not confirmed.",
            `Reconciliation settled ${reconcileOutcome.resolved.length} payment(s) from stored worker evidence without re-dispatching.`,
            `Status changed from UNKNOWN to ${latest.status}.`,
          ],
        };
        publishDemo(hooks, demonstration);
        result = {
          ok: true,
          payment: latest,
          message: `${paymentOutcome(latest)} Reconciliation settled ${reconcileOutcome.resolved.length} payment(s) from worker evidence.`,
          demonstration,
        };
        break;
      }
      case "leader": {
        let before: CoordinatorLeadership | null = null;
        let crashedAt = 0;
        progress(hooks, "Make sure both workers are healthy");
        await healthyWorkers(hooks);
        throwIfAborted(hooks.signal);
        progress(hooks, "Read current leader");
        before = await fetchCoordinatorLeadership();
        if (before.leader_id == null) {
          throw new Error("No leader has been elected yet. Wait a few seconds and run again.");
        }
        throwIfAborted(hooks.signal);
        progress(hooks, `Simulated leader crash for ${CRASH_SECONDS}s (development endpoint, not a real process kill)`);
        const crash = await crashLeader(CRASH_SECONDS);
        crashedAt = Date.now();
        hooks.setCrashed?.(crash.crashed_leader_id);
        throwIfAborted(hooks.signal);
        progress(hooks, "Send payment while leader is unavailable");
        flowStep(hooks, "Send payment during failover", FULL_PATH);
        payment = await pay(payload.amount, payload.description, scenarioKey("failover"));
        const paymentEvents = await loadEvents(payment.transaction_id);
        showPayment(hooks, payment);
        expectStatus(payment, "SUCCESS");
        throwIfAborted(hooks.signal);
        progress(hooks, "Verify new leader and higher term");
        const after = await fetchCoordinatorLeadership();
        if (!before || after.leader_id === before.leader_id || (after.term ?? 0) <= (before.term ?? 0)) {
          throw new Error(`Leadership did not change (leader ${after.leader_id}, term ${after.term}).`);
        }
        const waitSeconds = Math.max(3, Math.ceil(CRASH_SECONDS - (Date.now() - crashedAt) / 1000) + 4);
        progress(hooks, `Wait ${waitSeconds}s for crashed coordinator to recover`);
        for (let left = waitSeconds; left > 0; left -= 1) {
          throwIfAborted(hooks.signal);
          await sleep(1000);
        }
        hooks.setCrashed?.(null);
        throwIfAborted(hooks.signal);
        progress(hooks, "Check election log and rejoin");
        const crashed = before.leader_id;
        const [finalLeadership, log] = await Promise.all([fetchCoordinatorLeadership(), fetchElectionEvents(80)]);
        const rejoined = log.some((event) => event.coordinator_id === crashed && event.message.includes("rejoin-after-crash"));
        if (!rejoined) {
          throw new Error(`Coordinator ${crashed} has not rejoined yet.`);
        }
        demonstration = {
          caseId,
          leadership: {
            before,
            afterCrash: after,
            final: finalLeadership,
            crashedLeaderId: crash.crashed_leader_id,
            electionEvents: log,
            payment,
            paymentEvents,
          },
          narrative: [
            `Leader before crash: Coordinator ${before.leader_id} (term ${before.term}).`,
            `After failover: Coordinator ${after.leader_id} (term ${after.term}).`,
            "Payment succeeded while leadership was transitioning; election messages are listed below.",
          ],
        };
        publishDemo(hooks, demonstration);
        result = {
          ok: true,
          payment,
          message: `${paymentOutcome(payment)} Coordinator ${after.leader_id} leads at term ${after.term} (was ${before.term}). ${
            finalLeadership.leader_id === crashed
              ? `Coordinator ${crashed} rejoined as leader.`
              : `Coordinator ${crashed} rejoined as follower.`
          }`,
          demonstration,
        };
        break;
      }
      default:
        throw new Error(`Unknown case ${caseId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = { ok: false, payment, message, demonstration };
  } finally {
    try {
      await restoreAllWorkers(hooks.setWorkers);
    } catch (restoreError) {
      const restoreWarning =
        restoreError instanceof Error ? restoreError.message : "Could not reset worker fault switches to normal.";
      result = {
        ...result,
        restoreWarning,
        message: result.message ? `${result.message} Warning: ${restoreWarning}` : restoreWarning,
      };
    }
    hooks.setCrashed?.(null);
  }
  return result;
}

export function caseRequiresFaultInjection(caseId: CaseId): boolean {
  return getCaseDefinition(caseId).requiresFaultInjection;
}
