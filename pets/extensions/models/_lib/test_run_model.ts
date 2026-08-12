/**
 * In-memory context.runModel stub for tests. Not part of the official
 * swamp-testing helper (createModelTestContext stubs writeResource/
 * readResource/etc. but has no notion of runModel), so pets tests compose
 * this with createModelTestContext's context.
 */
import type { RunModelFn, RunModelResult } from "./fleet.ts";

/** Arguments captured from one runModel invocation. */
export interface RecordedRunModelCall {
  definition: string;
  method: string;
  arguments?: Record<string, unknown>;
}

/** Returns queued responses in call order; throws if a call runs out. */
export function queuedRunModel(
  responses: RunModelResult[],
): { runModel: RunModelFn; calls: RecordedRunModelCall[] } {
  const calls: RecordedRunModelCall[] = [];
  let next = 0;
  const runModel: RunModelFn = (options) => {
    calls.push(options);
    if (next >= responses.length) {
      throw new Error(
        `queuedRunModel: no response queued for call ${next + 1} ` +
          `(${options.definition}.${options.method})`,
      );
    }
    return Promise.resolve(responses[next++]);
  };
  return { runModel, calls };
}
