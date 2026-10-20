export type PaymentStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED";

export type Payment = {
  id: number;
  transaction_id: string;
  amount: string;
  description: string;
  status: PaymentStatus | string;
  worker_id: string | null;
  created_at: string;
  updated_at: string;
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
