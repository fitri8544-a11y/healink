/* =====================================================
   HEALINK 2.0
   SISTEM NOTIFIKASI AUTOMATIK PENTADBIR

   Firebase Admin SDK + GitHub Actions
===================================================== */

"use strict";

const {
  Timestamp,
  FieldValue
} = require("firebase-admin/firestore");

// ==========================================
// HEALINK NOTIFICATION CONFIGURATION
// ==========================================

// Mod ujian diaktifkan secara lalai.
// Tiada notifikasi dihantar semasa Dry Run.
const DRY_RUN = process.env.HEALINK_DRY_RUN !== "false";

// Had maksimum aktiviti bagi setiap pelaksanaan.
const MAX_ACTIVITIES = 50;

// Tempoh semakan aktiviti: 24 jam
const LOOKBACK_MINUTES = 1440;

// ==========================================
// FIREBASE INITIALIZATION
// ==========================================

function initializeFirebase() {

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS belum dikonfigurasi."
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

  return false;
}

// ==========================================
// READ HEALINK ACTIVITIES
// ==========================================

async function getRecentActivities(db) {

  console.log("Menyemak aktiviti HEALINK...");

  const now = Date.now();

  const lookbackStart = Timestamp.fromMillis(
    now - (LOOKBACK_MINUTES * 60 * 1000)
  );

  const snapshot = await db
    .collection("aktivitiPelajar")
    .where("masa", ">=", lookbackStart)
    .orderBy("masa", "asc")
    .get();

  const activities = [];

  snapshot.forEach((doc) => {

    const data = doc.data();

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

    const adminDoc = await db
      .collection("adminUsers")
      .doc(data.uid)
      .get();

    if (!adminDoc.exists) {
      continue;
    }

    const adminData = adminDoc.data();

    // Sekat akaun pentadbir yang dinyahaktifkan
    if (
      adminData.disabled === true ||
      adminData.active === false ||
      adminData.status === "inactive"
    ) {
      continue;
    }

    // Semak peranan dan sekolah
    if (!canReceiveNotification(adminData, activityData)) {
      continue;
    }

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

  for (let i = 0; i < tokens.length; i += 500) {

    const batch = tokens.slice(i, i + 500);

    const response = await messaging.sendEachForMulticast({
      tokens: batch,

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

    // Had maksimum percubaan
    if (attempts >= MAX_ATTEMPTS) {
      return false;
    }

    // Jangan hantar semula notifikasi yang sudah berjaya
    if (
      data.status === "sent" ||
      data.status === "partial"
    ) {
      return false;
    }

    // Semak rekod yang sedang diproses
    if (data.status === "processing") {

      const updatedAt = data.updatedAt?.toMillis?.() || 0;

      if (now - updatedAt < LOCK_DURATION_MS) {
        return false;
      }
    }

    // Benarkan percubaan semula
    if (
      data.status === "failed" ||
      data.status === "no_recipients" ||
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

  const { db, messaging } = initializeFirebase();

  console.log("Firebase Admin SDK berjaya dimulakan.");

  console.log(
    DRY_RUN
      ? "MOD UJIAN: AKTIF"
      : "MOD PENGHANTARAN: AKTIF"
  );

  const activities = await getRecentActivities(db);

  // Utamakan rekod tertua yang belum diproses.
  // Had 50 dikenakan selepas semakan notification_logs.

  const selectedActivities = activities
    .filter(activity => activity.perluPerhatian === true)
    .sort((a, b) => {
      return a.masa.toMillis() - b.masa.toMillis();
    });

  console.log(
    `Aktiviti memerlukan perhatian: ${selectedActivities.length}`
  );

  let processedCount = 0;
  let skippedCount = 0;

  for (const activity of selectedActivities) {

    if (processedCount >= MAX_ACTIVITIES) {
      console.log(
        "Had pemprosesan dicapai. Baki rekod disemak pada pelaksanaan seterusnya."
      );
      break;
    }

    // DRY RUN tidak menghantar FCM
    // dan tidak mengubah notification_logs.
    if (DRY_RUN) {

      const log = await db
        .collection("notification_logs")
        .doc(activity.id)
        .get();

      const status = log.exists
        ? log.data().status
        : "belum diproses";

      console.log(
        `DRY RUN | Aktiviti ${activity.id} | Status: ${status}`
      );

      processedCount++;
      continue;
    }

    // Semak dan tuntut rekod secara atomik
    const claimed = await claimNotification(
      db,
      activity.id
    );

    if (!claimed) {

      skippedCount++;

      console.log(
        `Aktiviti ${activity.id}: telah diproses / masih dikunci / had percubaan.`
      );

      continue;
    }

    processedCount++;

    try {

      const tokens = await getAuthorizedAdminTokens(
        db,
        activity
      );

      console.log(
        `Aktiviti ${activity.id} | Penerima layak: ${tokens.length}`
      );

      if (tokens.length === 0) {

        await updateNotificationStatus(
          db,
          activity.id,
          "no_recipients"
        );

        continue;
      }

      const result = await sendAdminNotification(
        messaging,
        tokens,
        activity
      );

      let status = "failed";

      if (
        result.successCount > 0 &&
        result.failureCount === 0
      ) {
        status = "sent";

      } else if (result.successCount > 0) {

        // Elakkan penghantaran semula kepada
        // penerima yang telah berjaya.
        status = "partial";
      }

      await updateNotificationStatus(
        db,
        activity.id,
        status,
        result
      );

    } catch (error) {

      console.error(
        `Gagal memproses aktiviti ${activity.id}:`,
        error.message
      );

      await updateNotificationStatus(
        db,
        activity.id,
        "failed"
      );
    }
  }

  console.log(
    `Jumlah diproses dalam pelaksanaan ini: ${processedCount}`
  );

  console.log(
    `Jumlah dilangkau kerana status log: ${skippedCount}`
  );

  console.log("==================================");
  console.log("PROSES NOTIFIKASI SELESAI");
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