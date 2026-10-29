import {
  authoringSubmitSchema,
  patchOperationSchema,
  skillFileSchema,
  skillGetSchema,
} from '@agentmind/core';
import { z } from 'zod';

/** SDK tools/list only serializes object roots. Factor shared fields once, describe
 * exact alternatives in JSON Schema, and retain the original strict union parser. */
function objectUnion(
  schema: z.ZodUnion | z.ZodDiscriminatedUnion,
  overrides: Record<string, z.ZodType> = {},
) {
  const options = schema.options as z.ZodObject[];
  const keys = [...new Set(options.flatMap((o) => Object.keys(o.shape)))];
  const common = keys.filter((k) => options.every((o) => k in o.shape));
  const shape: Record<string, z.ZodType> = {};
  for (const key of keys) {
    const variants = [...new Set(options.map((o) => o.shape[key]).filter(Boolean))] as z.ZodType[];
    let field = variants.length === 1 ? variants[0] : z.union(variants);
    if (!field) throw Error('Invalid transport schema');
    if (!common.includes(key)) field = field.optional();
    shape[key] = overrides[key] ?? field;
  }
  const alternatives = options.map((o) => {
    const literals = Object.fromEntries(
      common.flatMap((key) => {
        const field = o.shape[key];
        return field instanceof z.ZodLiteral ? [[key, { const: field.value }]] : [];
      }),
    );
    const forbidden = keys.filter((k) => !(k in o.shape));
    return {
      ...(Object.keys(literals).length ? { properties: literals } : {}),
      required: Object.keys(o.shape).filter((k) => !common.includes(k) && !o.shape[k].isOptional()),
      ...(forbidden.length ? { not: { anyOf: forbidden.map((k) => ({ required: [k] })) } } : {}),
    };
  });
  return z
    .strictObject(shape)
    .superRefine((value, context) => {
      if (!schema.safeParse(value).success)
        context.addIssue({
          code: 'custom',
          message:
            'Use exactly the fields required by the selected operation; check oneOf alternatives. No proposal was accepted.',
        });
    })
    .meta({ oneOf: alternatives });
}
// Nested operation union is factored too; the original parser remains authoritative.
const path = skillFileSchema.shape.path.regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/,
);
const patchInput = objectUnion(patchOperationSchema, { path });
export const compactAuthoringSubmitInput = objectUnion(authoringSubmitSchema, {
  files: z.array(skillFileSchema.extend({ path })).min(1).max(32).optional(),
  operations: z.array(patchInput).min(1).max(8).optional(),
});
export const skillGetInput = objectUnion(skillGetSchema);
