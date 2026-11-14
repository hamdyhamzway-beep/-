export interface DbUser {
  id: number;
  uid: string;
  email: string;
  fullName: string;
  phone: string | null;
  roleId: number;
  roleSlug: 'super_admin' | 'driver' | 'movement_manager' | 'accountant' | string;
  roleNameAr: string;
  permissions: string[];
  isActive: boolean;
}

export interface EnrichedDriver {
  id: number;
  userId: number | null;
  linkedEmail: string | null;
  driverCode: string;
  fullName: string;
  phone: string;
  emergencyContact: string | null;
  monthlyAgreedSalary: number;
  employmentStartDate: string;
  accountStatus: 'active' | 'inactive' | 'suspended' | string;
  photoUrl?: string | null;
  notes: string | null;
  schoolId: number | null;
  schoolName: string;
  vehicleId: number | null;
  busNumber: string;
  registrationNumber: string;
  vehicleOwnerName: string;
  vehicleOwnerPhone: string;
  routeId: number | null;
  routeName: string;
  pickupArea: string;
  dropoffArea: string;
  pickupTime: string;
  dropoffTime: string;
  todayAttendance?: string;
  currentSalary?: SalaryRecord | null;
}

export interface SchoolItem {
  id: number;
  name: string;
  contactName: string;
  contactPhone: string;
  address: string;
  lat: number;
  lng: number;
  monthlyContractValue: number;
  contractStartDate: string;
  contractEndDate: string;
  notes: string | null;
  isActive: boolean;
  vehicleCount?: number;
  driverCount?: number;
  ownerCost?: number;
  estimatedProfit?: number;
  routes?: RouteItem[];
}

export interface VehicleOwner {
  id: number;
  fullName: string;
  phone: string;
  nationalId: string | null;
  notes: string | null;
}

export interface FleetVehicle {
  id: number;
  busNumber: string;
  registrationNumber: string;
  vehicleType: string;
  ownerId: number | null;
  monthlyOwnerCost: number;
  operationalStatus: string;
  gpsStatus: string;
  notes: string | null;
  ownerName: string;
  ownerPhone: string;
  driverId: number | null;
  driverName: string;
  driverCode: string;
  driverPhone: string;
  schoolId: number | null;
  schoolName: string;
  routeId: number | null;
  routeName: string;
  isOnline: boolean;
  gps: {
    lat: number;
    lng: number;
    speedKmh: number;
    accuracyMeters: number | null;
    recordedAt: string;
    isLive: boolean;
    statusLabel: string;
  } | null;
}

export interface RouteItem {
  id: number;
  name: string;
  schoolId: number;
  pickupArea: string;
  dropoffArea: string;
  pickupTime: string;
  dropoffTime: string;
  estimatedDistanceKm: number | null;
}

export interface SalaryRecord {
  id: number;
  driverId: number;
  month: number;
  year: number;
  baseSalary: number;
  totalAdvances: number;
  totalCoverageDeductions: number;
  otherDeductions: number;
  bonuses: number;
  netSalary: number;
  status: 'open' | 'approved' | 'paid' | string;
  driverName?: string;
  driverCode?: string;
  schoolName?: string;
  busNumber?: string;
}

export interface AdvanceRecord {
  id: number;
  driverId: number;
  amount: number;
  date: string;
  reason: string;
  paymentMethod: string;
  notes: string | null;
  isReversed: boolean;
  driverName?: string;
  driverCode?: string;
  schoolName?: string;
  createdAt: string;
}

export interface CoverageRecord {
  id: number;
  absentDriverId: number;
  replacementDriverId: number | null;
  replacementExternalName: string | null;
  vehicleId: number | null;
  schoolId: number | null;
  date: string;
  actualReplacementCost: number;
  absentDriverDeduction: number;
  reason: string;
  notes: string | null;
  isReversed: boolean;
  absentDriverName?: string;
  absentDriverCode?: string;
  replacementDriverName?: string;
  schoolName?: string;
  busNumber?: string;
  createdAt: string;
}

export interface FinancialTransaction {
  id: number;
  driverId: number;
  month: number;
  year: number;
  type: string;
  direction: 'debit' | 'credit';
  amount: number;
  referenceType: string | null;
  referenceId: number | null;
  description: string;
  driverName?: string;
  driverCode?: string;
  createdAt: string;
}

export interface NotificationItem {
  id: number;
  recipientDriverId: number | null;
  targetRole: string | null;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}
