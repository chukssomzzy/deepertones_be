import { z } from '@hono/zod-openapi'

const Time = (what: string) =>
  z.string().max(16).openapi({ description: `${what} as a 24-hour time, \`HH:MM\`. Anything else is 400 \`VALIDATION_FAILED\`.`, example: '07:00' })

// Strict because `missedDaysChannel` is read-only: sending it is refused, not ignored.
export const UpdateRemindersBody = z
  .object({
    enabled: z.boolean().optional().openapi({ description: 'Remind me at the times below.' }),
    morning: Time('When to be reminded in the morning').optional(),
    evening: Time('When to be reminded in the evening').optional(),
    timeZone: z.string().max(64).nullable().optional().openapi({
      description: 'The phone\'s IANA time zone. Anything Intl does not know, and a fixed offset such as `+01:00`, is 400 `VALIDATION_FAILED`. The canonical name is stored (`africa/lagos` becomes `Africa/Lagos`). `null` clears it, and local days fall back to UTC.',
      example: 'Africa/Lagos',
    }),
    stepDownAlerts: z.boolean().optional().openapi({ description: 'Tell me when a step-down changes what I do.' }),
    missedDaysNudge: z.boolean().optional().openapi({ description: 'Nudge me when I have missed some days.' }),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: 'Name at least one setting' })
  .openapi('UpdateRemindersBody')

export const RemindersResponse = z
  .object({
    enabled: z.boolean(),
    morning: z.string().openapi({ example: '07:00' }),
    evening: z.string().openapi({ example: '21:00' }),
    timeZone: z.string().nullable().openapi({ description: 'The IANA time zone, or null until the phone reports one.', example: 'Africa/Lagos' }),
    stepDownAlerts: z.boolean(),
    missedDaysNudge: z.boolean(),
    missedDaysChannel: z.enum(['push', 'whatsapp']).openapi({
      description: 'Where the missed-days nudge goes. Read-only: `whatsapp` only when WhatsApp is an enabled channel here and the account has a verified phone, otherwise `push`.',
    }),
  })
  .openapi('Reminders')
