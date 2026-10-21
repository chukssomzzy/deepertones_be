import type { VendorSpendLedger } from '../../providers/perfect-corp/vendor-spend.provider'

/**
 * A VendorSpendLedger that keeps every record() it was asked for, in order, so a test can tell "recorded once" from "recorded twice" (the real
 * ledger would swallow the second as a repeat of the same task). `failNextWith` makes the next record() throw.
 */
export class FakeVendorSpendLedger implements VendorSpendLedger {
  readonly recorded: Parameters<VendorSpendLedger['record']>[0][] = []
  private failure: Error | undefined

  failNextWith(error: Error) {
    this.failure = error
  }

  async record(input: Parameters<VendorSpendLedger['record']>[0]): Promise<void> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.recorded.push({ ...input })
  }
}
