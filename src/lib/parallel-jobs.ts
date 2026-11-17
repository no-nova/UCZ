import { contextGroupCandidatesSync } from './codec'
// 并行任务的实际执行体：主线程与 worker 共用同一份代码，保证两边算出来的
// 结果是同一个比特流。
//
// 每个任务接收数据视图与纯标量。v20 配置在同步任务体里临时应用并 finally
// 恢复；任务体没有 await，不会把一个任务的配置泄漏给下一个任务。
// 其它未序列化的非默认诊断旋钮由主线程门禁退回串行。
import { chooseSpecForJob, encodeGroupForJob, encodeSpecsForJob } from './codec-jobs'
import type { JobPayload, JobReply } from './parallel'
import { cmV20Tuning, setStrictPriors } from './coder'
import { setActiveCompressionLevel } from './codec'

/**
 * Resident-set ceiling for a single job, in MiB.
 *
 * `memorySafeThreads` only decides *how many* workers to start; it cannot stop a run
 * that is already over budget. This guard is the runtime half of that promise: before a
 * job allocates anything it compares the process RSS against the ceiling taken from
 * `UCZ_RSS_LIMIT_MIB` (set by `--memory-limit`) and refuses the job instead of letting
 * the allocator push the machine into swap. Refusing is safe because every job is
 * re-runnable — the caller sees a clear error rather than an OOM kill.
 */
export const DEFAULT_RSS_LIMIT_MIB = 3584

export function rssLimitMib(): number {
  const raw = Number(process.env.UCZ_RSS_LIMIT_MIB)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_RSS_LIMIT_MIB
}

export function assertMemoryHeadroom(payload: JobPayload): void {
  const limit = rssLimitMib()
  const rss = process.memoryUsage().rss / (1024 * 1024)
  if (rss <= limit) return
  throw Error(`内存预算已用尽：RSS ${rss.toFixed(0)} MiB 超过上限 ${limit} MiB（任务 ${payload.kind} 已拒绝）`)
}

/** 执行一个任务。返回结构化克隆安全的纯数据。 */
export async function runJob(payload: JobPayload, data: Uint8Array): Promise<JobReply> {
  assertMemoryHeadroom(payload)
  const saved={...cmV20Tuning}
  if(payload.cmV20) {
    if(typeof payload.cmV20.enabled!=='boolean' || typeof payload.cmV20.binRecovery!=='boolean')throw Error('无效 v20 worker 配置')
    Object.assign(cmV20Tuning,payload.cmV20)
  }
  // 规划档位必须在 worker 里也生效，否则 `fast`/`balanced` 的裁剪只发生在主线程，
  // 工作线程仍按 `max` 逐候选试探（结果不会错，但会白花几分钟）。
  const restoreLevel = setActiveCompressionLevel(payload.level)
  // v23 严格零先验同样必须在 worker 里生效：否则主线程按 strict 选规格、写 ver 23，
  // 而 worker 仍按带先验的模型编码 payload，解码端就会不一致。
  const restoreStrict = setStrictPriors(!!payload.strictPrior)
  try { return runJobSync(payload,data) } finally {restoreStrict();restoreLevel();Object.assign(cmV20Tuning,saved)}
}
function runJobSync(payload:JobPayload,data:Uint8Array):JobReply {
  switch (payload.kind) {
    case 'contextGroup': return {kind:'contextGroup',candidates:contextGroupCandidatesSync(payload.parts.map(([a,b])=>data.subarray(a,b)),payload.spec,payload.positions,payload.retained,true,payload.rawText)}
    case 'chooseSpec': {
      const { start, end, cls, bestS, sampleLimit, base } = payload
      return chooseSpecForJob(data.subarray(start, end), cls, bestS, sampleLimit, base, data.length)
    }
    case 'encodeGroup': {
      const { parts, spec, positions, ends, skipBase, groupOptions } = payload
      const slices = parts.map(([s, e]) => data.subarray(s, e))
      return encodeGroupForJob(slices, spec, positions, ends, skipBase, groupOptions)
    }
    case 'encodeSpecs': {
      const { start, end, specs, base } = payload
      return encodeSpecsForJob(data.subarray(start, end), specs, base)
    }
    default:
      throw new Error(`未知任务类型 ${(payload as { kind: string }).kind}`)
  }
}
