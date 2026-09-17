import { ClientError, type OpenCodeClient } from "@opencode/client";
import { ClientError as LegacyClientError } from "@opencode/client-legacy";

// A session may outlive Bun's socket idle timer; each read wait stays shorter.
export async function waitForSession(
  session: Pick<OpenCodeClient["session"], "wait">,
  sessionID: string,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const pollDeadline = AbortSignal.timeout(30_000);
    try {
      await session.wait({ sessionID }, { signal: AbortSignal.any([signal, pollDeadline]) });
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (!pollDeadline.aborted || !(error instanceof ClientError || error instanceof LegacyClientError) || error.reason !== "Transport") throw error;
    }
  }
}
