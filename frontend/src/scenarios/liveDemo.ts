import {
  ApiError,
  crashLeader,
  createPayment,
  fetchCoordinatorLeadership,
  fetchElectionEvents,
  fetchPayment,
  reconcile,
} from "../api";
import type { CoordinatorLeadership } from "../types";
import type { FlowNode } from "../components/FlowDiagram";
import { CASE_DEFINITIONS } from "./definitions";
import { CRASH_SECONDS, healthyWorkersForDemo, pay, paymentOutcome, expectStatus, scenarioKey, setAllWorkers } from "./runners";
import type { LiveDemoContext, LiveDemoScenario } from "./types";

const FULL_PATH: FlowNode[] = ["you", "api", "leader", "worker", "db"];

async function healthyWorkers(ctx: LiveDemoContext): Promise<string> {
  return healthyWorkersForDemo(ctx.setWorkers);
}

export function buildLiveDemoScenarios(): LiveDemoScenario[] {
  const byId = Object.fromEntries(CASE_DEFINITIONS.map((def) => [def.id, def]));

  return [
    {
      ...byId.normal,
      breakIt: "Nothing. This is the baseline.",
      run: async ({ step, showPayment, setWorkers }) => {
        await step("Make sure both workers are healthy", ["worker"], () => healthyWorkers({ step, showPayment, setWorkers, setCrashed: () => {}, wait: async () => {} }));
        await step("Send a payment of 25.00", FULL_PATH, async () => {
          const payment = await pay("25.00", "Demo: normal payment", scenarioKey("normal"));
          showPayment(payment);
          expectStatus(payment, "SUCCESS");
          return paymentOutcome(payment);
        });
      },
    },
    {
      ...byId.double,
      run: async ({ step, showPayment, setWorkers }) => {
        const idempotencyKey = scenarioKey("retry");
        let first: Awaited<ReturnType<typeof pay>> | null = null;
        const ctx = { step, showPayment, setWorkers, setCrashed: () => {}, wait: async () => {} };
        await step("Make sure both workers are healthy", ["worker"], () => healthyWorkers(ctx));
        await step("First click: send 40.00", FULL_PATH, async () => {
          first = await pay("40.00", "Demo: retried payment", idempotencyKey);
          showPayment(first);
          return paymentOutcome(first);
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
      ...byId.conflict,
      breakIt: "Reuse the request ID, but change the amount from 30.00 to 99.00.",
      run: async ({ step, showPayment, setWorkers }) => {
        const idempotencyKey = scenarioKey("conflict");
        const ctx = { step, showPayment, setWorkers, setCrashed: () => {}, wait: async () => {} };
        await step("Make sure both workers are healthy", ["worker"], () => healthyWorkers(ctx));
        await step("Send 30.00 with a new request ID", FULL_PATH, async () => {
          const payment = await pay("30.00", "Demo: original payload", idempotencyKey);
          showPayment(payment);
          return paymentOutcome(payment);
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
      ...byId.failed,
      run: async ({ step, showPayment, setWorkers }) => {
        await step("Break it: switch both workers to always decline", ["worker"], async () => {
          await setAllWorkers("fail");
          setWorkers("fail");
          return "Workers A and B will now decline every payment. They are marked red in the diagram.";
        });
        try {
          await step("Send a payment of 12.00", FULL_PATH, async () => {
            const payment = await pay("12.00", "Demo: worker failure", scenarioKey("fail"));
            showPayment(payment);
            expectStatus(payment, "FAILED");
            return paymentOutcome(payment);
          });
        } finally {
          await step("Repair: switch the workers back to normal", ["worker"], () => healthyWorkers({ step, showPayment, setWorkers, setCrashed: () => {}, wait: async () => {} }));
        }
      },
    },
    {
      ...byId.unknown,
      run: async ({ step, wait, showPayment, setWorkers }) => {
        let payment: Awaited<ReturnType<typeof pay>> | null = null;
        await step("Break it: slow both workers to 8 seconds", ["worker"], async () => {
          await setAllWorkers("delay", 8);
          setWorkers("slow");
          return "Workers will now finish after the coordinator has stopped waiting. They are marked in the diagram.";
        });
        try {
          await step("Send a payment of 33.00 (takes about 10 seconds)", FULL_PATH, async () => {
            payment = await pay("33.00", "Demo: slow worker", scenarioKey("slow"));
            showPayment(payment);
            expectStatus(payment, "UNKNOWN");
            return `${paymentOutcome(payment)} On the retry, the second worker saw the payment was already taken and did not run it again.`;
          });
        } finally {
          await step("Repair: switch the workers back to normal", ["worker"], () => healthyWorkers({ step, showPayment, setWorkers, setCrashed: () => {}, wait: async () => {} }));
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
          return `${paymentOutcome(latest)} It went from UNKNOWN to SUCCESS.`;
        });
      },
    },
    {
      ...byId.leader,
      breakIt: `Crash the current leader for ${CRASH_SECONDS} seconds. It stops talking to the other coordinators.`,
      run: async ({ step, wait, showPayment, setCrashed, setWorkers }) => {
        let before: CoordinatorLeadership | null = null;
        let crashedAt = 0;
        await step("Make sure both workers are healthy", ["worker"], () => healthyWorkers({ step, showPayment, setWorkers, setCrashed, wait }));
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
          const payment = await pay("55.00", "Demo: payment during failover", scenarioKey("failover"));
          showPayment(payment);
          expectStatus(payment, "SUCCESS");
          return `${paymentOutcome(payment)} The API waited until a new leader was elected, then sent it there.`;
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
          const crashed = before?.leader_id;
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
}
