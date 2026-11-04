import { z } from "zod";

const title = z.string().trim().min(1).max(120);
export const memoryInputSchema = z
  .object({
    kind: z.enum(["preference", "workflow"]),
    title,
    content: z.string().trim().min(1).max(1000),
  })
  .strict();
export type MemoryInput = z.infer<typeof memoryInputSchema>;

export const personalMemorySchema = memoryInputSchema
  .extend({
    id: z.string().min(1),
    source: z.enum(["manual", "explicit", "learned"]),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    evidenceCount: z.number().int().nonnegative(),
  })
  .strict();
export type PersonalMemory = z.infer<typeof personalMemorySchema>;

export const workflowObservationSchema = z
  .object({
    activity: title,
    steps: z.array(z.string().trim().min(1).max(160)).min(2).max(8),
  })
  .strict();
export type WorkflowObservation = z.infer<typeof workflowObservationSchema>;
