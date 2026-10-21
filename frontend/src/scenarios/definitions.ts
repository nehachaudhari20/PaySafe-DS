import type { CaseDefinition } from "./types";

export const CASE_DEFINITIONS: CaseDefinition[] = [
  {
    id: "normal",
    title: "A normal payment",
    summary: "Send one payment through the API, coordinator, and a worker with no faults enabled.",
    problem: "Before breaking anything, see what a healthy payment looks like.",
    breakIt: "Nothing. This is the baseline.",
    expect: "The payment travels API → leader → one worker → database, and ends SUCCESS.",
    verdict: "The payment took the normal path and was saved exactly once.",
    requiresFaultInjection: false,
  },
  {
    id: "double",
    title: "User clicks Pay twice",
    summary: "Submit the same idempotency key and payload twice; the API must return one payment.",
    problem: "A reply gets lost, so the app (or the user) sends the same payment again. Without protection, they would be charged twice.",
    breakIt: "Send the exact same request twice, with the same request ID (idempotency key).",
    expect: "The second request gets back the first payment. Nothing is charged twice.",
    verdict: "Two clicks, one payment. The duplicate never reached a worker.",
    requiresFaultInjection: false,
  },
  {
    id: "conflict",
    title: "Same request ID, different amount",
    summary: "Reuse one idempotency key with a changed amount; the API must respond with HTTP 409.",
    problem: "A buggy client reuses a request ID for a different payment. Quietly returning the old payment would hide the bug.",
    breakIt: "Reuse the request ID, but change the amount on the second request.",
    expect: "The API refuses the second request (HTTP 409) and the original payment stays unchanged.",
    verdict: "Reusing a request ID with different data is caught and refused.",
    requiresFaultInjection: false,
  },
  {
    id: "failed",
    title: "The worker declines",
    summary: "Both workers are set to decline; the payment must end FAILED.",
    problem: "Some payments really fail, like a bank decline. The system has to report that honestly.",
    breakIt: "Switch both workers to always decline.",
    expect: "The worker says no. A clear decline is final, so it is not retried, and the payment ends FAILED.",
    verdict: "FAILED is used only when a worker actually reports a failure, unlike the next scenario where nobody knows.",
    requiresFaultInjection: true,
  },
  {
    id: "unknown",
    title: "The worker is too slow",
    summary: "Workers are delayed past the RPC deadline; expect UNKNOWN, then SUCCESS after reconciliation.",
    problem:
      "A worker may finish the payment but answer too late. Nobody knows if money moved. Calling it FAILED could be wrong, and blindly retrying could charge twice.",
    breakIt: "Slow both workers to 8 seconds. The coordinator only waits 5.",
    expect:
      "The payment is marked UNKNOWN, not FAILED. Later, reconciliation reads what the worker actually did and corrects it to SUCCESS, without running it again.",
    verdict: "The uncertain result was reported honestly, then fixed from evidence. Nothing ran twice.",
    requiresFaultInjection: true,
    showsReconcile: true,
  },
  {
    id: "leader",
    title: "The leader crashes",
    summary: "Simulate leader crash via the development endpoint; survivors elect a new leader and a payment still succeeds.",
    problem: "Only the leader coordinator gives out work. If it dies and nobody takes over, payments stop.",
    breakIt: "Crash the current leader for a bounded time. It stops renewing its lease.",
    expect:
      "The other two notice its heartbeats have stopped and hold an election (highest surviving ID wins). The new leader gets a higher term number, and a payment sent meanwhile still succeeds.",
    verdict: "Payments kept working through a leader crash, and there was never more than one leader.",
    requiresFaultInjection: true,
    showsElection: true,
  },
];

export function getCaseDefinition(id: string): CaseDefinition {
  return CASE_DEFINITIONS.find((item) => item.id === id) ?? CASE_DEFINITIONS[0];
}
