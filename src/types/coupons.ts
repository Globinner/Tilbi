export type CouponRow = {
  id: number;
  code: string;
  durationMonths: number;
  planType: string;
  label: string;
  maxRedemptions: number;
  redemptionCount: number;
  remaining: number;
  expiresAt: string | null;
  notes: string | null;
  createdAt: string;
};
