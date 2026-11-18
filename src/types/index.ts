import type { SchoolBillingRange } from '../lib/billing-cycle';

export type { SchoolBillingRange };

export interface DbUser {
  id: number;
  uid: string;
  email: string;
  fullName: string;
  phone: string | null;
  roleId: number;
  roleSlug: 'super_admin' | 'driver' | 'supervisor' | 'movement_manager' | 'accountant' | 'employee' | string;
  roleNameAr: string;
  permissions: string[];
  customPermissions?: string[] | null;
  assignedSchoolIds: number[];
  assignedSchoolNames?: string[];
  staffCode?: string | null;
  employeeId?: number | null;
  isActive: boolean;
}

export interface DriverLicensePhoto {
  id: string;
  label: string;
  imageUrl: string;
  uploadedBy: 'admin' | 'driver' | string;
  uploadedAt: string;
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
  licensePhotos?: DriverLicensePhoto[];
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

export interface SchoolDriverSalarySummary {
  id: number;
  driverCode: string;
  fullName: string;
  phone: string;
  busNumber: string;
  routeName: string;
  monthlyAgreedSalary: number;
  baseSalary: number;
  totalAdvances: number;
  totalCoverageDeductions: number;
  otherDeductions: number;
  bonuses: number;
  netSalary: number;
  salaryStatus: string;
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
  billingCycleType?: 'calendar' | 'shifted' | string;
  billingCycleStartDay?: number;
  currentBillingRange?: SchoolBillingRange;
  vehicleCount?: number;
  driverCount?: number;
  ownerCost?: number;
  totalDriverSalaries?: number;
  totalNetDriverSalaries?: number;
  estimatedProfit?: number;
  routes?: RouteItem[];
  vehicles?: FleetVehicle[];
  drivers?: SchoolDriverSalarySummary[];
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
  schoolId: number | null;
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
  schoolId?: number | null;
  schoolName?: string;
  busNumber?: string;
  routeName?: string;
}

export interface SchoolFinanceContract {
  schoolId: number | null;
  schoolName: string;
  isActive: boolean;
  monthlyContractValue: number;
  contactPerson?: string;
  contactPhone?: string;
  driversCount: number;
  totalBaseSalaries: number;
  totalAdvances: number;
  totalCoverageDeductions: number;
  totalOtherDeductions: number;
  totalBonuses: number;
  totalNetSalaries: number;
  profit: number;
  netPayoutProfit: number;
  profitMarginPct: number;
  billingRange?: SchoolBillingRange;
  supervisorsCount?: number;
  totalSupervisorSalaries?: number;
  drivers: SalaryRecord[];
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
  schoolId?: number | null;
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
  schoolId?: number | null;
  schoolName?: string;
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

export interface EmployeeLinkedUserSummary {
  id: number;
  email: string;
  roleId: number;
  roleSlug: string;
  roleNameAr: string;
  staffCode: string;
  assignedSchoolIds: number[];
  assignedSchoolNames?: string[];
  customPermissions: string[] | null;
  permissions: string[];
  isActive: boolean;
}

export interface EmployeeRecord {
  id: number;
  employeeCode: string;
  fullName: string;
  jobTitle: string;
  phone: string;
  schoolId?: number | null;
  schoolName?: string;
  monthlySalary: number;
  bonuses: number;
  deductions: number;
  netSalary: number;
  employmentStartDate: string;
  status: 'active' | 'inactive' | string;
  notes: string | null;
  linkedUser?: EmployeeLinkedUserSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupervisorLiveLocation {
  lat: number;
  lng: number;
  speedKmh: number;
  accuracyMeters: number | null;
  recordedAt: string;
  isLive: boolean;
}

export interface SupervisorTripRecord {
  tripDate: string;
  morningStartedAt: string | null;
  morningLat: number | null;
  morningLng: number | null;
  eveningEndedAt: string | null;
  eveningLat: number | null;
  eveningLng: number | null;
}

export interface SupervisorRecord {
  id: number;
  userId?: number | null;
  linkedEmail?: string;
  supervisorCode: string;
  fullName: string;
  phone: string;
  photoUrl?: string | null;
  schoolId: number | null;
  schoolName: string;
  schoolAddress?: string;
  schoolLat?: number | null;
  schoolLng?: number | null;
  vehicleId: number | null;
  busNumber: string;
  registrationNumber: string;
  routeId: number | null;
  routeName: string;
  pickupArea: string;
  dropoffArea: string;
  pickupTime: string;
  dropoffTime: string;
  estimatedDistanceKm?: number | null;
  assignedDriverName?: string;
  assignedDriverPhone?: string;
  accountStatus: 'active' | 'inactive' | string;
  monthlySalary?: number;
  cycleTripsCount?: number;
  billingRange?: SchoolBillingRange;
  notes?: string | null;
  liveLocation?: SupervisorLiveLocation | null;
  todayTrip?: SupervisorTripRecord | null;
}

export interface SupervisorCycleSummaryItem {
  supervisorId: number;
  supervisorCode: string;
  fullName: string;
  phone: string;
  schoolId: number | null;
  schoolName: string;
  monthlySalary: number;
  tripsCount: number;
  morningTripsCount: number;
  eveningTripsCount: number;
  completedDaysCount: number;
  billingRange: SchoolBillingRange;
  accountStatus: string;
}

export interface SupervisorTrackedVehicle {
  vehicleId: number;
  busNumber: string;
  registrationNumber: string;
  vehicleType: string;
  gpsStatus: string;
  routeName: string;
  driverName: string;
  driverPhone: string;
  isOnline: boolean;
  gps: {
    lat: number;
    lng: number;
    speedKmh: number;
    heading: number | null;
    accuracyMeters: number | null;
    recordedAt: string;
    isLive: boolean;
    statusLabel: string;
  } | null;
  trail: Array<{
    id: number;
    lat: number;
    lng: number;
    speedKmh: number;
    recordedAt: string;
  }>;
}

export interface SupervisorAppResponse {
  linked: boolean;
  supervisor: {
    id: number;
    supervisorCode: string;
    fullName: string;
    phone: string;
    photoUrl?: string | null;
    accountStatus: string;
    notes: string;
    liveLocation?: SupervisorLiveLocation | null;
  } | null;
  todayTrip?: SupervisorTripRecord | null;
  school: {
    id: number;
    name: string;
    address: string;
    lat: number;
    lng: number;
    contactName: string;
    contactPhone: string;
  } | null;
  route: {
    id: number;
    name: string;
    pickupArea: string;
    dropoffArea: string;
    pickupTime: string;
    dropoffTime: string;
    estimatedDistanceKm: number | null;
  } | null;
  trackedVehicles: SupervisorTrackedVehicle[];
}

// ==================== Unified Chat & Communication Hub ====================
export type ChatMessageType = 'text' | 'voice_note' | 'call_log' | 'ptt_audio' | 'system';

export interface ChatMessage {
  id: number;
  channelId?: number | null;
  roomKey: string;
  senderUserId?: number | null;
  senderRole: 'super_admin' | 'admin' | 'driver' | 'supervisor' | string;
  senderName: string;
  senderAvatar?: string | null;
  messageType: ChatMessageType;
  textContent?: string;
  audioDataUrl?: string | null;
  audioDurationSec?: number;
  isRead?: boolean;
  createdAt: string;
}

export interface ChatChannel {
  id: number;
  roomKey: string;
  channelType: 'broadcast' | 'drivers_broadcast' | 'route' | 'direct';
  title: string;
  routeId?: number | null;
  routeName?: string;
  schoolId?: number | null;
  schoolName?: string;
  driverId?: number | null;
  driverName?: string;
  supervisorId?: number | null;
  supervisorName?: string;
  lastMessageText?: string | null;
  lastMessageAt: string;
  unreadCount?: number;
  onlineParticipantsCount?: number;
}

export interface ChatSyncPayload {
  type: 'new_message' | 'incoming_call' | 'call_ended' | 'ptt_stream' | 'presence';
  roomKey: string;
  message?: ChatMessage;
  callData?: {
    callerName: string;
    callerRole: string;
    roomKey: string;
    status: 'ringing' | 'active' | 'ended';
  };
}

export interface FinanceGrandTotals {
  schoolsCount: number;
  driversCount: number;
  employeesCount: number;
  vehiclesCount: number;
  totalSchoolContracts: number;
  totalDriverBaseSalaries: number;
  totalDriverAdvances: number;
  totalCoverageReplacementCost: number;
  totalCoverageDriverDeductions: number;
  totalOtherDeductions: number;
  totalBonuses: number;
  totalDriverNetSalaries: number;
  totalPaidSalaries: number;
  totalUnpaidSalaries: number;
  totalEmployeeBaseSalaries: number;
  totalEmployeeBonuses: number;
  totalEmployeeDeductions: number;
  totalEmployeeNetSalaries: number;
  totalVehicleOwnerCosts: number;
  totalCombinedPayroll: number;
  totalLedgerCredits: number;
  totalLedgerDebits: number;
  netLedgerBalance: number;
  contractsProfitAfterDrivers: number;
  overallNetBalance: number;
  supervisorsCount?: number;
  totalSupervisorSalaries?: number;
}

export interface DailyReportAttachment {
  id: string;
  name: string;
  url: string;
  type: string;
  category?: 'invoice' | 'maintenance' | 'fuel' | 'receipt' | 'other';
  categoryLabel?: string;
  sizeKb?: number;
  createdAt?: string;
}

export interface DailyReportRecord {
  id: number;
  userId: number | null;
  employeeId: number | null;
  schoolId?: number | null;
  schoolName?: string;
  employeeName: string;
  employeeRoleOrTitle: string;
  reportDate: string; // YYYY-MM-DD
  rawContent: string;
  audioDataUrl?: string | null;
  audioDurationSec?: number;
  reportType: 'operations' | 'financial' | 'mixed' | 'urgent';
  targetAudience: 'both' | 'accountant' | 'manager';
  financialAmount: number;
  extractedTasks: string[];
  attachments?: DailyReportAttachment[];
  category: string;
  status: 'submitted' | 'reviewed_by_accountant' | 'reviewed_by_manager' | 'approved';
  accountantNotes?: string;
  managerNotes?: string;
  createdAt: string;
  updatedAt: string;
}


