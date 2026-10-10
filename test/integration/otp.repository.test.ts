import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1OtpRepository } from '../../src/modules/otp/otp.repository'
import { otpRepositoryContract } from '../../src/modules/otp/otp.repository.contract'

otpRepositoryContract('D1', () => new D1OtpRepository(createDb(env.DB)))
