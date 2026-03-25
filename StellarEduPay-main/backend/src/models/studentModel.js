const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  class: { type: String, required: true, index: true },
  feeAmount: { type: Number, required: true },
  feePaid: { type: Boolean, default: false, index: true },
  totalPaid: { type: Number, default: 0 },
  remainingBalance: { type: Number, default: null },
  feePaid: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('Student', studentSchema);
