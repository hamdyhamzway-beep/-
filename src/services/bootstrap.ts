import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  advances,
  attendance,
  coverageRecords,
  driverAssignments,
  drivers,
  financialTransactions,
  gpsLocations,
  notifications,
  routes,
  salaries,
  schools,
  vehicleOwners,
  vehicles,
} from '../db/schema.ts';
import { recalculateDriverSalary } from './finance.ts';

let seededChecked = false;

/**
 * Bootstraps initial operational master data once when the database is completely empty
 * so the owner can immediately test schools, buses, live Cairo GPS map, financial ledger,
 * and Egyptian Arabic voice commands (e.g. driver 1025, driver 25, مدرسة إشراقة الغد).
 */
export async function ensureStarterOperationalData(adminUserId: number) {
  if (seededChecked) return;
  const countRes = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schools);
  if ((countRes[0]?.count ?? 0) > 0) {
    seededChecked = true;
    return;
  }

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const todayStr = now.toISOString().slice(0, 10);

  await db.transaction(async (tx) => {
    const insertedSchools = await tx
      .insert(schools)
      .values([
        {
          name: 'مدرسة إشراقة الغد الدولية',
          contactName: 'أ. طارق المنصور',
          contactPhone: '01001234567',
          address: 'التجمع الخامس - شارع التسعين الجنوبي، القاهرة الجديدة',
          lat: 30.0176,
          lng: 31.4342,
          monthlyContractValue: '84000.00',
          contractStartDate: '2026-09-01',
          contractEndDate: '2027-06-30',
          notes: '3 باصات سقف عالي لطلاب المرحلة الابتدائية والإعدادية',
        },
        {
          name: 'مدارس النيل المصرية - المعادي',
          contactName: 'د. سحر عبد العزيز',
          contactPhone: '01009876543',
          address: 'زهراء المعادي - الشطر العاشر، القاهرة',
          lat: 29.9636,
          lng: 31.3095,
          monthlyContractValue: '58000.00',
          contractStartDate: '2026-09-01',
          contractEndDate: '2027-06-30',
          notes: '2 باص لنقل المعلمين والإدارة والطلاب',
        },
        {
          name: 'أكاديمية الرواد للغات',
          contactName: 'م. وليد الشريف',
          contactPhone: '01112223344',
          address: 'مدينة نصر - محور المشير طنطاوي، القاهرة',
          lat: 30.0448,
          lng: 31.3652,
          monthlyContractValue: '31000.00',
          contractStartDate: '2026-09-01',
          contractEndDate: '2027-06-30',
          notes: 'باص سقف عالي 14 راكب لخط مدينة نصر ومصر الجديدة',
        },
      ])
      .returning();

    const insertedOwners = await tx
      .insert(vehicleOwners)
      .values([
        {
          fullName: 'الحاج عبد الرحمن صابر',
          phone: '01223344556',
          nationalId: '27504120102345',
          notes: 'مالك 3 سيارات تويوتا هايس سقف عالي',
        },
        {
          fullName: 'شركة النصر للتوريدات والنقل',
          phone: '01098877665',
          nationalId: '3010554422',
          notes: 'مورد أسطول المعادي ومدينة نصر',
        },
      ])
      .returning();

    const insertedVehicles = await tx
      .insert(vehicles)
      .values([
        {
          busNumber: 'B-101',
          registrationNumber: 'أ ب ج 4821',
          vehicleType: 'تويوتا هايس سقف عالي 14 راكب',
          ownerId: insertedOwners[0].id,
          monthlyOwnerCost: '21500.00',
          operationalStatus: 'active',
          gpsStatus: 'online',
        },
        {
          busNumber: 'B-102',
          registrationNumber: 'س ص ع 7193',
          vehicleType: 'تويوتا هايس سقف عالي 14 راكب',
          ownerId: insertedOwners[0].id,
          monthlyOwnerCost: '21500.00',
          operationalStatus: 'active',
          gpsStatus: 'online',
        },
        {
          busNumber: 'B-103',
          registrationNumber: 'م ن هـ 3054',
          vehicleType: 'تويوتا هايس سقف عالي 14 راكب',
          ownerId: insertedOwners[0].id,
          monthlyOwnerCost: '21000.00',
          operationalStatus: 'active',
          gpsStatus: 'offline',
        },
        {
          busNumber: 'B-201',
          registrationNumber: 'ق ر ش 9281',
          vehicleType: 'باص كوستر 26 راكب',
          ownerId: insertedOwners[1].id,
          monthlyOwnerCost: '23000.00',
          operationalStatus: 'active',
          gpsStatus: 'online',
        },
        {
          busNumber: 'B-202',
          registrationNumber: 'ط ظ ع 5510',
          vehicleType: 'تويوتا هايس سقف عالي 14 راكب',
          ownerId: insertedOwners[1].id,
          monthlyOwnerCost: '21000.00',
          operationalStatus: 'active',
          gpsStatus: 'offline',
        },
        {
          busNumber: 'B-301',
          registrationNumber: 'د ذ ر 1148',
          vehicleType: 'تويوتا هايس سقف عالي 14 راكب',
          ownerId: insertedOwners[1].id,
          monthlyOwnerCost: '22000.00',
          operationalStatus: 'active',
          gpsStatus: 'online',
        },
      ])
      .returning();

    const insertedRoutes = await tx
      .insert(routes)
      .values([
        {
          name: 'خط التجمع الخامس — الرحاب',
          schoolId: insertedSchools[0].id,
          pickupArea: 'بوابة 6 الرحاب وميدان مصطفى كامل',
          dropoffArea: 'مدرسة إشراقة الغد الدولية',
          pickupTime: '06:35',
          dropoffTime: '14:40',
          estimatedDistanceKm: 18.5,
        },
        {
          name: 'خط التجمع الأول — البنفسج',
          schoolId: insertedSchools[0].id,
          pickupArea: 'منطقة البنفسج وشارع محور السادات',
          dropoffArea: 'مدرسة إشراقة الغد الدولية',
          pickupTime: '06:45',
          dropoffTime: '14:35',
          estimatedDistanceKm: 14.2,
        },
        {
          name: 'خط مدينتي — المستقبل',
          schoolId: insertedSchools[0].id,
          pickupArea: 'مدينتي B1 - B6',
          dropoffArea: 'مدرسة إشراقة الغد الدولية',
          pickupTime: '06:20',
          dropoffTime: '14:50',
          estimatedDistanceKm: 24.0,
        },
        {
          name: 'خط المعادي — دجلة والثكنات',
          schoolId: insertedSchools[1].id,
          pickupArea: 'ميدان الحرية ودجلة المعادي',
          dropoffArea: 'مدارس النيل المصرية - المعادي',
          pickupTime: '06:50',
          dropoffTime: '14:25',
          estimatedDistanceKm: 11.8,
        },
        {
          name: 'خط المقطم — الهضبة الوسطى',
          schoolId: insertedSchools[1].id,
          pickupArea: 'شارع 9 المقطم والهضبة الوسطى',
          dropoffArea: 'مدارس النيل المصرية - المعادي',
          pickupTime: '06:40',
          dropoffTime: '14:30',
          estimatedDistanceKm: 13.4,
        },
        {
          name: 'خط مصر الجديدة — عباس العقاد',
          schoolId: insertedSchools[2].id,
          pickupArea: 'روكسي وشارع عباس العقاد',
          dropoffArea: 'أكاديمية الرواد للغات',
          pickupTime: '06:45',
          dropoffTime: '14:30',
          estimatedDistanceKm: 15.1,
        },
      ])
      .returning();

    const insertedDrivers = await tx
      .insert(drivers)
      .values([
        {
          driverCode: '1025',
          fullName: 'محمد أحمد حسن',
          phone: '01012345678',
          emergencyContact: '01099887766 (أخيه محمود)',
          monthlyAgreedSalary: '7500.00',
          employmentStartDate: '2025-09-01',
          accountStatus: 'active',
          notes: 'ملتزم بالمواعيد ويشرف على طلاب الابتدائي',
        },
        {
          driverCode: '25',
          fullName: 'أحمد محمود إبراهيم',
          phone: '01123456789',
          emergencyContact: '01155443322',
          monthlyAgreedSalary: '7000.00',
          employmentStartDate: '2025-10-15',
          accountStatus: 'active',
          notes: 'سائق خط البنفسج',
        },
        {
          driverCode: '1030',
          fullName: 'خالد حسن علي',
          phone: '01234567890',
          emergencyContact: '01211223344',
          monthlyAgreedSalary: '7800.00',
          employmentStartDate: '2024-09-01',
          accountStatus: 'active',
          notes: 'خط مدينتي — مسار طويل',
        },
        {
          driverCode: '1042',
          fullName: 'سامي عبد الله مصطفى',
          phone: '01556677889',
          emergencyContact: '01511223344',
          monthlyAgreedSalary: '7200.00',
          employmentStartDate: '2025-09-10',
          accountStatus: 'active',
          notes: 'خط المعادي ودجلة',
        },
        {
          driverCode: '1050',
          fullName: 'طارق فؤاد السيد',
          phone: '01066778899',
          emergencyContact: '01022334455',
          monthlyAgreedSalary: '6800.00',
          employmentStartDate: '2026-01-05',
          accountStatus: 'active',
          notes: 'خط المقطم',
        },
        {
          driverCode: '1064',
          fullName: 'كريم سعيد عبد الحميد',
          phone: '01188776655',
          emergencyContact: '01144556677',
          monthlyAgreedSalary: '7300.00',
          employmentStartDate: '2025-09-01',
          accountStatus: 'active',
          notes: 'خط مصر الجديدة ومدينة نصر',
        },
      ])
      .returning();

    // Assign each driver to school + vehicle + route
    await tx.insert(driverAssignments).values([
      {
        driverId: insertedDrivers[0].id,
        schoolId: insertedSchools[0].id,
        vehicleId: insertedVehicles[0].id,
        routeId: insertedRoutes[0].id,
        isCurrent: true,
      },
      {
        driverId: insertedDrivers[1].id,
        schoolId: insertedSchools[0].id,
        vehicleId: insertedVehicles[1].id,
        routeId: insertedRoutes[1].id,
        isCurrent: true,
      },
      {
        driverId: insertedDrivers[2].id,
        schoolId: insertedSchools[0].id,
        vehicleId: insertedVehicles[2].id,
        routeId: insertedRoutes[2].id,
        isCurrent: true,
      },
      {
        driverId: insertedDrivers[3].id,
        schoolId: insertedSchools[1].id,
        vehicleId: insertedVehicles[3].id,
        routeId: insertedRoutes[3].id,
        isCurrent: true,
      },
      {
        driverId: insertedDrivers[4].id,
        schoolId: insertedSchools[1].id,
        vehicleId: insertedVehicles[4].id,
        routeId: insertedRoutes[4].id,
        isCurrent: true,
      },
      {
        driverId: insertedDrivers[5].id,
        schoolId: insertedSchools[2].id,
        vehicleId: insertedVehicles[5].id,
        routeId: insertedRoutes[5].id,
        isCurrent: true,
      },
    ]);

    // Attendance for today
    await tx.insert(attendance).values([
      { driverId: insertedDrivers[0].id, date: todayStr, status: 'present', recordedByUserId: adminUserId },
      { driverId: insertedDrivers[1].id, date: todayStr, status: 'present', recordedByUserId: adminUserId },
      { driverId: insertedDrivers[2].id, date: todayStr, status: 'absent', notes: 'ظرف عائلي طارئ', recordedByUserId: adminUserId },
      { driverId: insertedDrivers[3].id, date: todayStr, status: 'present', recordedByUserId: adminUserId },
      { driverId: insertedDrivers[4].id, date: todayStr, status: 'present', recordedByUserId: adminUserId },
      { driverId: insertedDrivers[5].id, date: todayStr, status: 'present', recordedByUserId: adminUserId },
    ]);

    // Real initial financial entries for the current month
    const adv1 = await tx
      .insert(advances)
      .values({
        driverId: insertedDrivers[0].id,
        amount: '1000.00',
        date: todayStr,
        reason: 'سلفة منتصف الشهر',
        paymentMethod: 'instapay',
        notes: 'تحويل إنستاباي',
        recordedByUserId: adminUserId,
      })
      .returning();

    const adv2 = await tx
      .insert(advances)
      .values({
        driverId: insertedDrivers[1].id,
        amount: '600.00',
        date: todayStr,
        reason: 'ظرف شخصي',
        paymentMethod: 'cash',
        recordedByUserId: adminUserId,
      })
      .returning();

    const adv3 = await tx
      .insert(advances)
      .values({
        driverId: insertedDrivers[3].id,
        amount: '1500.00',
        date: todayStr,
        reason: 'مصاريف دراسية',
        paymentMethod: 'vodafone_cash',
        recordedByUserId: adminUserId,
      })
      .returning();

    const cov1 = await tx
      .insert(coverageRecords)
      .values({
        absentDriverId: insertedDrivers[2].id,
        replacementExternalName: 'سائق احتياطي - عماد شوقي',
        vehicleId: insertedVehicles[2].id,
        schoolId: insertedSchools[0].id,
        date: todayStr,
        actualReplacementCost: '350.00',
        absentDriverDeduction: '400.00',
        reason: 'تغطية وردية صباحية ومسائية',
        recordedByUserId: adminUserId,
      })
      .returning();

    await tx.insert(financialTransactions).values([
      {
        driverId: insertedDrivers[0].id,
        month,
        year,
        type: 'advance',
        direction: 'debit',
        amount: '1000.00',
        referenceType: 'advance',
        referenceId: adv1[0].id,
        description: 'سلفة: سلفة منتصف الشهر (instapay)',
        recordedByUserId: adminUserId,
      },
      {
        driverId: insertedDrivers[1].id,
        month,
        year,
        type: 'advance',
        direction: 'debit',
        amount: '600.00',
        referenceType: 'advance',
        referenceId: adv2[0].id,
        description: 'سلفة: ظرف شخصي (cash)',
        recordedByUserId: adminUserId,
      },
      {
        driverId: insertedDrivers[3].id,
        month,
        year,
        type: 'advance',
        direction: 'debit',
        amount: '1500.00',
        referenceType: 'advance',
        referenceId: adv3[0].id,
        description: 'سلفة: مصاريف دراسية (vodafone_cash)',
        recordedByUserId: adminUserId,
      },
      {
        driverId: insertedDrivers[2].id,
        month,
        year,
        type: 'coverage_deduction',
        direction: 'debit',
        amount: '400.00',
        referenceType: 'coverage',
        referenceId: cov1[0].id,
        description: `خصم تغطية غياب بتاريخ ${todayStr}`,
        recordedByUserId: adminUserId,
      },
      {
        driverId: insertedDrivers[0].id,
        month,
        year,
        type: 'bonus',
        direction: 'credit',
        amount: '300.00',
        referenceType: 'bonus',
        description: 'مكافأة التزام وانضباط خط الرحاب',
        recordedByUserId: adminUserId,
      },
    ]);

    for (const d of insertedDrivers) {
      await recalculateDriverSalary(tx, d.id, month, year);
    }

    // GPS locations: 4 live recent pings (< 1 min ago) and 2 stale/offline cached pings (> 40 mins ago)
    const recentTime = new Date(Date.now() - 35 * 1000);
    const staleTime = new Date(Date.now() - 48 * 60 * 1000);

    await tx.insert(gpsLocations).values([
      {
        vehicleId: insertedVehicles[0].id,
        driverId: insertedDrivers[0].id,
        lat: 30.0321,
        lng: 31.4685,
        speedKmh: 48,
        heading: 145,
        accuracyMeters: 8,
        isLive: true,
        recordedAt: recentTime,
      },
      {
        vehicleId: insertedVehicles[1].id,
        driverId: insertedDrivers[1].id,
        lat: 30.0254,
        lng: 31.4211,
        speedKmh: 36,
        heading: 90,
        accuracyMeters: 10,
        isLive: true,
        recordedAt: recentTime,
      },
      {
        vehicleId: insertedVehicles[2].id,
        driverId: insertedDrivers[2].id,
        lat: 30.0952,
        lng: 31.6354,
        speedKmh: 0,
        heading: 0,
        accuracyMeters: 25,
        isLive: false,
        recordedAt: staleTime,
      },
      {
        vehicleId: insertedVehicles[3].id,
        driverId: insertedDrivers[3].id,
        lat: 29.9602,
        lng: 31.2681,
        speedKmh: 52,
        heading: 210,
        accuracyMeters: 7,
        isLive: true,
        recordedAt: recentTime,
      },
      {
        vehicleId: insertedVehicles[4].id,
        driverId: insertedDrivers[4].id,
        lat: 30.0114,
        lng: 31.3012,
        speedKmh: 0,
        heading: 0,
        accuracyMeters: 30,
        isLive: false,
        recordedAt: staleTime,
      },
      {
        vehicleId: insertedVehicles[5].id,
        driverId: insertedDrivers[5].id,
        lat: 30.0685,
        lng: 31.3342,
        speedKmh: 41,
        heading: 180,
        accuracyMeters: 9,
        isLive: true,
        recordedAt: recentTime,
      },
    ]);

    await tx.insert(notifications).values([
      {
        recipientDriverId: insertedDrivers[0].id,
        type: 'advance',
        title: 'تحديث كشف الراتب',
        body: 'تمت إضافة مكافأة التزام 300 ج.م وتسجيل سلفة 1,000 ج.م في حسابك للشهر الحالي.',
      },
      {
        targetRole: 'super_admin',
        type: 'gps_alert',
        title: 'تنبيه انقطاع إشارة GPS',
        body: 'الباص B-103 (خط مدينتي) والباص B-202 (خط المقطم) لم يرسلا تحديثاً منذ أكثر من 45 دقيقة.',
      },
    ]);
  });

  seededChecked = true;
}
