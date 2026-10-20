/* =====================================================
   HEALINK 2.0
   SISTEM NOTIFIKASI AUTOMATIK PENTADBIR

   Firebase Admin SDK + GitHub Actions
===================================================== */

"use strict";

const admin = require("firebase-admin");

// ==========================================
// HEALINK NOTIFICATION CONFIGURATION
// ==========================================

// Mod ujian diaktifkan secara lalai.
// Tiada notifikasi dihantar semasa Dry Run.
const DRY_RUN = process.env.HEALINK_DRY_RUN !== "false";

// Had maksimum aktiviti bagi setiap pelaksanaan.
const MAX_ACTIVITIES = 50;

// Tempoh semakan aktiviti dalam minit.
const LOOKBACK_MINUTES = 30;

// ==========================================
// FIREBASE INITIALIZATION
// ==========================================

function initializeFirebase() {

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALIALS belum dikonfigurasi."
    );
  }

  const {
    initializeApp,
    getApps,
    applicationDefault
  } = require("firebase-admin/app");

  const { getFirestore } = require("firebase-admin/firestore");
  const { getMessaging } = require("firebase-admin/messaging");

  const app = getApps().length
    ? getApps()[0]
    : initializeApp({
        credential: applicationDefault(),
        projectId: "bimbingankaunselingskkk"
      });

  return {
    db: getFirestore(app),
    messaging: getMessaging(app)
  };

}

// ==========================================
// NORMALIZE SCHOOL NAME
// ==========================================

function normalizeSchoolName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

// ==========================================
// CHECK ADMIN ACCESS
// ==========================================

function canReceiveNotification(adminData, activityData) {

  if (!adminData || !activityData) {
    return false;
  }

  const role = String(adminData.role || "")
    .trim()
    .toLowerCase();

  const adminSchool = normalizeSchoolName(
    adminData.sekolah
  );

  const activitySchool = normalizeSchoolName(
    activityData.organisasi
  );

  // Super Admin boleh menerima semua sekolah
  if (role === "superadmin" && adminSchool === "ALL") {
    return true;
  }

  // School Admin hanya sekolah sendiri
  if (role === "schooladmin") {

    return Boolean(activitySchool) &&
      adminSchool === activitySchool;

  }

  // Peranan lain tidak dibenarkan
  return false;
}

// ==========================================
// READ HEALINK ACTIVITIES
// ==========================================

async function getRecentActivities(db) {

  console.log("Menyemak aktiviti HEALINK...");

  const now = Date.now();

  // Semak aktiviti dalam tempoh 30 minit terakhir.
  // Ini hanya untuk pembangunan dan ujian awal.
  const { Timestamp, FieldValue } = require("firebase-admin/firestore");

  const thirtyMinutesAgo =
    Timestamp.fromMillis(
      now - (30 * 60 * 1000)
    );

  const snapshot = await db
    .collection("aktivitiPelajar")
    .where("masa", ">=", thirtyMinutesAgo)
    .orderBy("masa", "asc")
    .get();

  const activities = [];

  snapshot.forEach((doc) => {

    const data = doc.data();

    // Abaikan rekod tanpa organisasi
    if (!normalizeSchoolName(data.organisasi)) {
      return;
    }

    activities.push({
      id: doc.id,
      organisasi: normalizeSchoolName(
        data.organisasi
      ),
      perluPerhatian: data.perluPerhatian === true,
      masa: data.masa
    });

  });

  console.log(
    `Jumlah aktiviti ditemui: ${activities.length}`
  );

  return activities;
}

// ==========================================
// GET AUTHORIZED ADMIN FCM TOKENS
// ==========================================

async function getAuthorizedAdminTokens(db, activityData) {

  const tokens = new Set();

  // Ambil senarai langganan FCM
  const subscriptions = await db
    .collection("push_subscriptions")
    .get();

  for (const subscription of subscriptions.docs) {

    const data = subscription.data();

    if (
      typeof data.uid !== "string" ||
      typeof data.token !== "string" ||
      !data.uid.trim() ||
      !data.token.trim()
    ) {
      continue;
    }

    // Semak akaun pentadbir yang sebenar
    const adminDoc = await db
      .collection("adminUsers")
      .doc(data.uid)
      .get();

    if (!adminDoc.exists) {
      continue;
    }

    const adminData = adminDoc.data();

// ==========================================
// SEMAK STATUS AKAUN PENTADBIR
// ==========================================

// Sekat akaun yang dinyahaktifkan secara jelas
if (
  adminData.disabled === true ||
  adminData.active === false ||
  adminData.status === "inactive"
) {
  continue;
}

// ==========================================
// SEMAK PERANAN DAN SEKOLAH
// ==========================================

if (!canReceiveNotification(adminData, activityData)) {
  continue;
}

    // Elakkan token sama dimasukkan berulang kali
    tokens.add(data.token);
  }

  console.log(
    `Jumlah token pentadbir yang layak: ${tokens.size}`
  );

  return [...tokens];
}

// ==========================================
// SEND FCM NOTIFICATION
// ==========================================

async function sendAdminNotification(
  messaging,
  tokens,
  activityData
) {

  if (!Array.isArray(tokens) || tokens.length === 0) {
    console.log("Tiada token pentadbir yang layak.");
    return {
      successCount: 0,
      failureCount: 0
    };
  }

  // Mesej umum tanpa maklumat peribadi murid
  const title = "🔔 Makluman HEALINK 2.0";

  const body = activityData.perluPerhatian === true
    ? "Terdapat aktiviti baharu yang memerlukan perhatian pentadbir."
    : "Terdapat aktiviti baharu dalam sistem HEALINK.";

  let successCount = 0;
  let failureCount = 0;

  // FCM menyokong maksimum 500 token setiap kelompok
  for (let i = 0; i < tokens.length; i += 500) {

    const batch = tokens.slice(i, i + 500);

    const response = await messaging.sendEachForMulticast({
      tokens: batch,

      // Data-only message: Service Worker akan
      // memaparkan notifikasi ketika Dashboard ditutup.
      data: {
        title,
        body,
        url: "/dashboard.html"
      },

      webpush: {
        headers: {
          Urgency: activityData.perluPerhatian === true
            ? "high"
            : "normal"
        }
      }
    });

    successCount += response.successCount;
    failureCount += response.failureCount;
  }

  console.log(
    `FCM: ${successCount} berjaya, ${failureCount} gagal.`
  );

  return {
    successCount,
    failureCount
  };
}

// ==========================================
// NOTIFICATION PROCESSING LOCK & RETRY
// ==========================================

async function claimNotification(db, activityId) {

  const logRef = db
    .collection("notification_logs")
    .doc(activityId);

  const MAX_ATTEMPTS = 3;
  const LOCK_DURATION_MS = 15 * 60 * 1000;

  return db.runTransaction(async (transaction) => {

    const snapshot = await transaction.get(logRef);

    const now = Date.now();

    // Rekod belum pernah diproses
    if (!snapshot.exists) {

      transaction.create(logRef, {
        status: "processing",
        attempts: 1,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      return true;
    }

    const data = snapshot.data();

    const attempts = Number(data.attempts || 0);

    // Had percubaan
    if (attempts >= MAX_ATTEMPTS) {
      return false;
    }

    // Rekod berjaya atau tiada penerima
    if (
      data.status === "sent" ||
      data.status === "partial" ||
      data.status === "no_recipients"
    ) {
      return false;
    }

    // Rekod sedang diproses
    if (data.status === "processing") {

      const updatedAt = data.updatedAt?.toMillis?.() || 0;

      if (now - updatedAt < LOCK_DURATION_MS) {
        return false;
      }
    }

    // Benarkan percubaan semula
    if (
      data.status === "failed" ||
      data.status === "processing"
    ) {

      transaction.update(logRef, {
        status: "processing",
        attempts: attempts + 1,
        updatedAt: FieldValue.serverTimestamp()
      });

      return true;
    }

    return false;
  });
}

// ==========================================
// UPDATE NOTIFICATION STATUS
// ==========================================

async function updateNotificationStatus(
  db,
  activityId,
  status,
  details = {}
) {

  const allowedStatuses = [
    "sent",
    "partial",
    "failed",
    "no_recipients"
  ];

  if (!allowedStatuses.includes(status)) {
    throw new Error("Status notifikasi tidak sah.");
  }

  const logRef = db
    .collection("notification_logs")
    .doc(activityId);

  await logRef.update({
    status,
    successCount: details.successCount || 0,
    failureCount: details.failureCount || 0,
    updatedAt: FieldValue.serverTimestamp()
  });

  console.log(
    `Status notifikasi dikemas kini: ${status}`
  );
}

// ==========================================
// MAIN
// ==========================================

async function main() {

  console.log("==================================");
  console.log("HEALINK 2.0 - NOTIFIKASI AUTOMATIK");
  console.log("==================================");

  // Keselamatan: hanya benarkan mod ujian buat masa ini.
  if (!DRY_RUN) {
    throw new Error(
      "Penghantaran sebenar belum diaktifkan. Gunakan HEALINK_DRY_RUN=true."
    );
  }

  const { db } = initializeFirebase();

  console.log("Firebase Admin SDK berjaya dimulakan.");
  console.log("MOD UJIAN: AKTIF");
  console.log("Tiada notifikasi akan dihantar.");

  // ========================================
  // 1. BACA AKTIVITI
  // ========================================

  const activities = await getRecentActivities(db);

  const selectedActivities = activities.slice(
    0,
    MAX_ACTIVITIES
  );

  console.log(
    `Aktiviti untuk disemak: ${selectedActivities.length}`
  );

  // ========================================
  // 2. SEMAK PENERIMA
  // ========================================

  for (const activity of selectedActivities) {

    const tokens = await getAuthorizedAdminTokens(
      db,
      activity
    );

    console.log(
      `Aktiviti disemak | Penerima layak: ${tokens.length}`
    );

    // DRY RUN:
    // Tidak menghantar FCM.
    // Tidak mencipta notification_logs.
    // Tidak mengubah data Firestore.
  }

  console.log("==================================");
  console.log("UJIAN SELESAI");
  console.log("==================================");
}

// ==========================================
// RUN
// ==========================================

if (require.main === module) {
  main().catch((error) => {

    console.error(
      "Ralat sistem notifikasi:",
      error.stack || error.message
    );

    process.exitCode = 1;

  });
}