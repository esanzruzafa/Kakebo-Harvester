import { z } from "zod";

export const accountRemovalRequestSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    mode: z.enum(["keep-history", "delete-history"])
  })
  .strict();

export type AccountRemovalRequest = z.infer<typeof accountRemovalRequestSchema>;

export function parseAccountRemovalRequest(input: unknown): AccountRemovalRequest {
  return accountRemovalRequestSchema.parse(input);
}

export function assertTrustedDesktopRequest(input: {
  expectedSenderId: number | undefined;
  expectedUrl: string | undefined;
  senderId: number;
  senderUrl: string | undefined;
  closing: boolean;
}): void {
  if (
    input.expectedSenderId === undefined ||
    input.expectedUrl === undefined ||
    input.senderId !== input.expectedSenderId ||
    input.senderUrl !== input.expectedUrl
  ) {
    throw new Error("Rejected IPC request from an untrusted renderer.");
  }
  if (input.closing) throw new Error("The application is closing.");
}

export async function executeAccountRemovalRequest<Result>(input: {
  request: unknown;
  hasActiveOperation: () => boolean;
  remove: (request: AccountRemovalRequest) => Promise<Result>;
}): Promise<Result> {
  const request = parseAccountRemovalRequest(input.request);
  if (input.hasActiveOperation()) {
    throw new Error("Wait for the current account operation to finish before removing an account.");
  }
  return await input.remove(request);
}
