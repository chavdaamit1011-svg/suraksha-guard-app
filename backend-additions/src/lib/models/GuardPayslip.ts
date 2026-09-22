import { Schema, model, models } from 'mongoose';

/**
 * Guard payslips (PRD 18.13, SUR-GAP-023).
 *
 * Money is **integer paise** everywhere (canon §4). Floating-point rupees accumulate rounding
 * error across a payroll run, and a guard who is short by a rupee does not care that it was a
 * float.
 *
 * The guard app only ever reads this. A payslip is produced by the agency's payroll run; what
 * the app computes on its own is the in-month *estimate*, which is never written here.
 */

const LineSchema = new Schema(
  {
    code: { type: String, required: true }, // basic | overtime | allowance | incentive | advance | pf | esi | other
    label: { type: String, default: '' },
    amountPaise: { type: Number, required: true },
  },
  { _id: false }
);

const GuardPayslipSchema = new Schema(
  {
    guardId: { type: String, required: true, index: true },
    agencyId: { type: String, default: '', index: true },
    /** "YYYY-MM". One payslip per guard per period. */
    period: { type: String, required: true, index: true },

    daysPresent: { type: Number, default: 0 },
    daysAbsent: { type: Number, default: 0 },
    paidLeave: { type: Number, default: 0 },
    otHours: { type: Number, default: 0 },

    earnings: { type: [LineSchema], default: [] },
    deductions: { type: [LineSchema], default: [] },
    grossPaise: { type: Number, default: 0 },
    deductionsPaise: { type: Number, default: 0 },
    netPaise: { type: Number, default: 0 },

    /**
     * Draft → Pending (finalised, unpaid) → Completed (paid) → Archived (PRD 18.13 §11).
     * The app shows "Estimated" for anything that is not at least Pending.
     */
    status: { type: String, enum: ['Draft', 'Pending', 'Completed', 'Archived'], default: 'Draft', index: true },
    paidOn: { type: Date, default: null },
    /** Bank UTR or UPI reference, shown verbatim — it is what a guard checks against their bank. */
    referenceNo: { type: String, default: '' },

    /** Carried forward when advances exceed earnings, so net pay is never shown negative. */
    carriedForwardPaise: { type: Number, default: 0 },
  },
  { timestamps: true }
);

GuardPayslipSchema.index({ guardId: 1, period: 1 }, { unique: true });

export const GuardPayslip = models.GuardPayslip || model('GuardPayslip', GuardPayslipSchema);
