/* ════════════════════════════════════════════════════════════════
   ESC — SafeSearch moderation (Cloud Functions, Gen 2)
   يفحص كل صورة تُرفع تحت community_files/.../articles أو .../shorts
   عبر Google Cloud Vision SafeSearch. لو كانت إباحية/عراة (adult/racy)
   يحذف الملف فوراً ويحذف المنشور المرتبط من Firestore.
   النشر:  firebase deploy --only functions
   يتطلب تفعيل Cloud Vision API على المشروع.
   ════════════════════════════════════════════════════════════════ */
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const vision = require("@google-cloud/vision");

initializeApp();
const db = getFirestore();
const visionClient = new vision.ImageAnnotatorClient();

/* درجات Vision: VERY_UNLIKELY..VERY_LIKELY. نعتبر LIKELY/VERY_LIKELY انتهاكاً */
const BLOCK = new Set(["LIKELY", "VERY_LIKELY"]);
function isUnsafe(safe) {
  if (!safe) return false;
  return BLOCK.has(safe.adult) || BLOCK.has(safe.racy) || BLOCK.has(safe.violence);
}

/* مسار التخزين → رابط التنزيل العام المُخزَّن في وثيقة المنشور */
function publicUrl(bucketName, objectPath) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media`;
}

/* احذف المنشور الذي يشير إلى هذا الملف (مقالة عبر images[]، أو مقطع عبر storagePath/url) */
async function deleteLinkedPost(objectPath, bucketName) {
  const url = publicUrl(bucketName, objectPath);

  /* المقاطع: نخزّن storagePath مباشرةً */
  const shortByPath = await db.collection("shorts").where("storagePath", "==", objectPath).get();
  for (const d of shortByPath.docs) { await d.ref.delete(); }
  if (!shortByPath.empty) return "shorts";

  /* المقالات: images مصفوفة روابط عامة */
  const artByImg = await db.collection("articles").where("images", "array-contains", url).get();
  for (const d of artByImg.docs) { await d.ref.delete(); }
  if (!artByImg.empty) return "articles";

  /* احتياط: مطابقة عبر url للمقاطع القديمة */
  const shortByUrl = await db.collection("shorts").where("url", "==", url).get();
  for (const d of shortByUrl.docs) { await d.ref.delete(); }
  if (!shortByUrl.empty) return "shorts";

  return null;
}

exports.moderateUpload = onObjectFinalized(
  { region: "us-central1", memory: "512MiB", timeoutSeconds: 120 },
  async (event) => {
    const obj = event.data;
    const objectPath = obj.name || "";
    const contentType = obj.contentType || "";
    const bucketName = obj.bucket;

    /* صور منشورات المجتمع + صور البروفايل (avatars) — تجاهل PDF وغيرها */
    if (!contentType.startsWith("image/")) return;
    const isCommunity = objectPath.startsWith("community_files/");
    const isAvatar    = objectPath.startsWith("avatars/");
    if (!isCommunity && !isAvatar) return;

    let safe;
    try {
      const [result] = await visionClient.safeSearchDetection(`gs://${bucketName}/${objectPath}`);
      safe = result.safeSearchAnnotation;
    } catch (err) {
      console.error("Vision SafeSearch failed for", objectPath, err);
      return; /* لا نحذف عند فشل الفحص حتى لا نخسر محتوى سليماً */
    }

    if (!isUnsafe(safe)) return;

    console.warn("Unsafe image detected, removing:", objectPath, safe);
    if (isAvatar) {
      /* avatars/{username} → امسح avatarURL من وثيقة الطالب */
      const username = objectPath.split("/")[1] || "";
      if (username) {
        try { await db.collection("students").doc(username).update({ avatarURL: "" }); }
        catch (e) { console.error("avatar reset error", e); }
      }
    } else {
      /* احذف المنشور المرتبط */
      try { await deleteLinkedPost(objectPath, bucketName); }
      catch (e) { console.error("deleteLinkedPost error", e); }
    }
    /* ثم احذف الملف نفسه */
    try { await getStorage().bucket(bucketName).file(objectPath).delete(); }
    catch (e) { console.error("file delete error", e); }
  }
);
