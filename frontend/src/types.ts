export type PaymentStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "UNKNOWN";

export type Payment = {
  id: number;
  transaction_id: string;
  amount: string;
  description: string;
  status: PaymentStatus | string;
  worker_id: string | null;
  idempotency_key: string | null;
  reconciliation_required: boolean;
  attempt_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkerFault = {
  worker_id: string;
  mode: string;
  delay_seconds: number;
};

export type WorkerHealth = {
  worker_id: string;
  reachable: boolean;
  status: string;
};

export type WorkersHealthResponse = {
  coordinator_reachable: boolean;
  workers: WorkerHealth[];
  detail?: string;
};
