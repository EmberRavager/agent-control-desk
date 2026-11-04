import { z } from "zod";

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "时区无效");
export const scheduleRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("once"), at: z.iso.datetime({ offset: true }) })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      minutes: z.number().int().min(1).max(525600),
    })
    .strict(),
  z.object({ kind: z.literal("daily"), time, timeZone }).strict(),
  z
    .object({
      kind: z.literal("weekly"),
      time,
      timeZone,
      days: z
        .array(z.number().int().min(0).max(6))
        .min(1)
        .max(7)
        .refine((days) => new Set(days).size === days.length, "星期不能重复"),
    })
    .strict(),
]);
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;
export const scheduleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(20000),
    cwd: z.string().min(1).max(4096),
    agentId: z.string().min(1).max(200),
    rule: scheduleRuleSchema,
  })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  recordedAt: string;
  status: "dispatched" | "missed" | "skipped" | "failed" | "unknown";
  detail: string;
  taskId?: string;
}
export interface Schedule extends ScheduleInput {
  id: string;
  status: "active" | "paused" | "finished";
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun?: ScheduleRun;
}
