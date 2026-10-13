import type { z } from 'zod'
import type { Container } from '../container'
import { deliverOtp } from '../modules/otp/otp.jobs'
import type { JobDefinition } from './job'

/** Every background job. Only the Worker entry (src/index.ts) imports this; lint:arch enforces it. */
export const jobs: JobDefinition<z.ZodType, Container>[] = [deliverOtp]
