/**
 * v0.5: shared streaming wrapper used by all three provider clients.
 *
 * The contract:
 *
 *   const stream = await client.X.stream({ ... });
 *
 *   // Consume incrementally
 *   for await (const chunk of stream) {
 *     process.stdout.write(extractText(chunk));
 *   }
 *
 *   // Then read the final result
 *   const { cacheInfo, raw } = await stream.final();
 *   console.log(cacheInfo.cachedTokens, cacheInfo.dollarsSaved);
 *
 * Or, if the caller doesn't want incremental chunks, they can skip the
 * iteration entirely and just await `stream.final()` — the wrapper will
 * drain the underlying stream itself.
 *
 * Memory: the wrapper keeps only a user-supplied accumulator (the
 * `state`), NOT the raw chunks themselves. Provider integrations typically
 * use the state to retain only the most-recent usage object, so memory
 * is bounded regardless of stream length.
 */

import type { CacheInfo } from "../types.js";

/** Final result emitted after the stream completes. */
export interface CachedStreamFinal<TRaw = unknown> {
  cacheInfo: CacheInfo;
  /**
   * Provider-specific raw "final" object — e.g. Anthropic's `Message`
   * with full usage, or the last OpenAI chunk that carried `usage`.
   * Optional because some providers may not produce one.
   */
  raw?: TRaw;
}

/** Hooks the provider supplies to drive cacheInfo extraction. */
export interface CachedStreamHooks<TChunk, TState, TRaw = unknown> {
  /** Initial accumulator value. */
  initialState: TState;
  /**
   * Called once per chunk before the chunk is yielded. Must return the
   * new state. Optional — defaults to identity (state never changes).
   */
  onChunk?: (chunk: TChunk, state: TState) => TState;
  /**
   * Called exactly once after the upstream stream completes successfully.
   * Returns the final `cacheInfo` (and optionally a `raw` payload).
   * Async to allow providers that expose a single "finalMessage()" call.
   */
  finalize: (state: TState) => Promise<CachedStreamFinal<TRaw>>;
}

/**
 * Async-iterable wrapper around a provider stream. Iterates chunks
 * transparently while building up a small state object that drives
 * cacheInfo computation in `finalize`.
 */
export class CachedStream<TChunk, TState = unknown, TRaw = unknown>
  implements AsyncIterable<TChunk>
{
  private iteratorStarted = false;
  private readonly finalPromise: Promise<CachedStreamFinal<TRaw>>;
  private finalResolve!: (value: CachedStreamFinal<TRaw>) => void;
  private finalReject!: (reason: unknown) => void;

  constructor(
    private readonly source: AsyncIterable<TChunk>,
    private readonly hooks: CachedStreamHooks<TChunk, TState, TRaw>,
  ) {
    this.finalPromise = new Promise((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
    });
  }

  /**
   * Iterate the stream. Each chunk is forwarded to the consumer AFTER
   * the state is updated. The stream can only be iterated once.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<TChunk, void, unknown> {
    if (this.iteratorStarted) {
      throw new Error(
        "CachedStream can only be iterated once. Call client.X.stream() again for a new stream.",
      );
    }
    this.iteratorStarted = true;
    let state = this.hooks.initialState;
    try {
      for await (const chunk of this.source) {
        if (this.hooks.onChunk) {
          state = this.hooks.onChunk(chunk, state);
        }
        yield chunk;
      }
      const final = await this.hooks.finalize(state);
      this.finalResolve(final);
    } catch (err) {
      this.finalReject(err);
      throw err;
    }
  }

  /**
   * Await the final result. If the caller never iterated, drains the
   * stream internally first. Safe to call any number of times — always
   * returns the same resolved value.
   */
  async final(): Promise<CachedStreamFinal<TRaw>> {
    if (!this.iteratorStarted) {
      for await (const _chunk of this) {
        // Discard — we only want the final.
      }
    }
    return this.finalPromise;
  }
}
