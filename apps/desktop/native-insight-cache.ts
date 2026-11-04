import type { NativeInsight } from "../../packages/contracts/index.js";

export const nativeInsightInterval = 30_000;
interface CacheEntry {
  value?: NativeInsight;
  updatedAt: number;
  attemptedAt: number;
  error?: string;
  pending?: Promise<NativeInsight>;
}
export type NativeInsightCache = Map<string, CacheEntry>;

export function nativeInsightFresh(entry?: CacheEntry): boolean {
  return !!entry?.value && Date.now() - entry.updatedAt < nativeInsightInterval;
}

/** A window's display cache survives navigation; the service owns model execution. */
export function loadNativeInsight(
  cache: NativeInsightCache,
  key: string,
  load: () => Promise<NativeInsight>,
  force = false,
): Promise<NativeInsight> {
  let entry = cache.get(key);
  if (entry?.pending) return entry.pending;
  if (!force && nativeInsightFresh(entry))
    return Promise.resolve(entry!.value!);
  if (!entry) {
    if (cache.size >= 50) cache.delete(cache.keys().next().value!);
    entry = { updatedAt: 0, attemptedAt: 0 };
    cache.set(key, entry);
  }
  const current = entry;
  current.attemptedAt = Date.now();
  current.error = undefined;
  current.pending = Promise.resolve()
    .then(load)
    .then((value) => {
      if (cache.get(key) !== current)
        throw Error("任务或模型配置已更新，请重新分析。");
      current.value = value;
      // This is the last validation time. The service may reuse an unchanged
      // analysis while preserving its original generatedAt timestamp.
      current.updatedAt = Date.now();
      return value;
    })
    .catch((failure: unknown) => {
      current.error =
        failure instanceof Error ? failure.message : "暂时无法分析当前任务";
      throw failure;
    })
    .finally(() => {
      current.pending = undefined;
    });
  return current.pending;
}
