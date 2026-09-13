// Thin wrapper so call sites read the same way regardless of which
// Cloudflare Queue they're sending to — mirrors queue.go's single
// Enqueue(queueURL, task, payload) entry point.
export interface QueueMessage {
  task: string;
  job_id: string;
  args: Record<string, unknown>;
}

export async function enqueue(queue: Queue, task: string, args: Record<string, unknown>): Promise<string> {
  const jobId = crypto.randomUUID();
  await queue.send({ task, job_id: jobId, args });
  return jobId;
}
