import { expect, spyOn, test } from "bun:test";
import { ClientError } from "@opencode/client";
import { waitForSession } from "../src/session-wait";

function abortedWait(signal: AbortSignal) {
  return new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new ClientError("Transport", {cause:signal.reason})), {once:true}));
}

test("poll timeouts keep waiting for the same session without restarting it", async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(5));
  const sessions:string[]=[];
  try {
    await waitForSession({wait:async(input,options)=>{sessions.push(input.sessionID);if(sessions.length<3)await abortedWait(options!.signal!);}},"ses_synthetic",new AbortController().signal);
    expect(sessions).toEqual(["ses_synthetic","ses_synthetic","ses_synthetic"]);
  } finally {timeout.mockRestore();}
});

test("a real transport failure is propagated rather than retried",async()=>{
  const failure=new ClientError("Transport",{cause:new Error("synthetic connection failure")});let calls=0;
  await expect(waitForSession({wait:async()=>{calls++;throw failure;}},"ses_synthetic",new AbortController().signal)).rejects.toBe(failure);
  expect(calls).toBe(1);
});

test("task cancellation stops the active wait and never starts another",async()=>{
  const controller=new AbortController();const reason=new Error("synthetic task cancelled");let calls=0;
  const waiting=waitForSession({wait:async(_input,options)=>{calls++;return abortedWait(options!.signal!);}},"ses_synthetic",controller.signal);
  controller.abort(reason);await expect(waiting).rejects.toBe(reason);expect(calls).toBe(1);
});
