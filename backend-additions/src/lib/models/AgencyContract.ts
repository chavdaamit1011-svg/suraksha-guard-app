import mongoose from 'mongoose';

const AgencyContractSchema = new mongoose.Schema({
  agencyOwnerId: { type: String, required: true },
  client: { type: String, required: true },
  clientId: { type: String, default: '' },
  site: { type: String, default: 'All Sites' },
  siteId: { type: String, default: '' },
  title: { type: String, required: true },
  startDate: { type: String, required: true },
  endDate: { type: String, default: '' },
  paymentTerms: { type: Number, default: 30 },
  ratePerGuard: { type: Number, required: true },
  guardsContracted: { type: Number, required: true },
  shiftHours: { type: Number, default: 8 },
  shiftTiming: { type: String, default: '' },
  gstTreatment: { type: String, default: 'Forward charge' },
  status: { type: String, default: 'Active' },
  invoices: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  paidAmount: { type: Number, default: 0 },
  pendingAmount: { type: Number, default: 0 },
  paymentStatus: { type: String, default: 'Pending' }, // 'Paid' | 'Pending' | 'Overdue' | 'Partial'
  assignedGuards: [{
    guardId: String,
    name: String,
    phone: String,
    slotIndex: Number,
    siteName: { type: String, default: '' },
    status: { type: String, enum: ['Pending', 'Accepted', 'Rejected', 'Quit'], default: 'Pending' },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, default: '' },
    quitAt: { type: Date },
    quitReason: { type: String, default: '' },
    assignedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

delete (mongoose.models as any).AgencyContract;
export default mongoose.models.AgencyContract || mongoose.model('AgencyContract', AgencyContractSchema);
