/* ════════════════════════════════════════════════════════════════
   ESC — وحدة الإشراف على المحتوى (Content Moderation)
   مجانية بالكامل، تعمل في المتصفح (client-side) كطبقة أولى قبل الرفع.
   تُكمّلها Cloud Function (Vision SafeSearch) كطبقة ثانية على الخادم.

   تصدّر:
     • checkText(str)        → {ok, reason}   فلتر نصوص مسيئة (عربي/إنجليزي)
     • checkImage(file)      → {ok, reason, scores}  كشف عُري/إباحية عبر NSFWJS
     • rateLimit(key, max, windowMs) → {ok, waitMs}  حدّ معدّل ضد السبام/البوتات
     • honeypotTrap(formEl)  → يزرع حقلاً خفياً يكشف البوتات
     • isHoneypotFilled(formEl) → bool
   ════════════════════════════════════════════════════════════════ */

/* ───────────────────────────────────────────────
   1) فلتر النصوص المسيئة
   نطبّع النص أولاً لكسر التحايل (مسافات/تشكيل/تكرار حروف/أرقام بدل حروف)
   ثم نطابق قائمة جذور كلمات. القائمة قابلة للتوسعة.
   ─────────────────────────────────────────────── */

/* تطبيع عربي: إزالة التشكيل، توحيد الألف/الهاء/الياء، إزالة التطويل */
function normalizeArabic(s) {
  return s
    .replace(/[ً-ٰٟ]/g, '')   /* تشكيل */
    .replace(/ـ/g, '')                  /* تطويل ـ */
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه');
}

/* leetspeak/تحايل لاتيني → حروف */
function deLeet(s) {
  return s
    .replace(/[@4]/g, 'a').replace(/[0]/g, 'o').replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e').replace(/[5$]/g, 's').replace(/[7]/g, 't');
}

/* تطبيع شامل: تصغير، إزالة فواصل بين الحروف، فكّ التكرار، تطبيع عربي/لاتيني */
function normalize(s) {
  let t = String(s || '').toLowerCase();
  t = deLeet(t);
  t = normalizeArabic(t);
  /* إزالة كل ما ليس حرفاً عربياً/لاتينياً (يكسر "ك.ل.م.ة" و "k l m") */
  t = t.replace(/[^a-zء-ي]/g, '');
  /* فكّ تكرار الحرف 3+ مرات → حرف واحد (يكسر "كلللمة") */
  t = t.replace(/(.)\1{2,}/g, '$1');
  return t;
}

/* جذور كلمات محظورة (بعد التطبيع، بلا تشكيل/مسافات).
   ركّزنا على السباب/الجنسي/الكراهية الصريح. وسّعها حسب الحاجة. */
const BAD_ROOTS = [
  /* عربي — سباب/جنسي صريح (جذور بعد التطبيع) */
  'كسم','كسمك','كصم','عرص','عاهر','عاهره','شرموط','شرموطه','منيوك','منيوكه',
  'متناك','متناكه','زانيه','زاني','لوطي','خول','خوال','نياكه','طيز','زب',
  'كحبه','قحبه','شذوذ','اباحي','اباحيه','سكس','نيك','نياك','ينيك','احا',
  'يلعن','منيك','وسخه','حقير','كلب','حيوان','غبي','تافه','حمار',
  /* إنجليزي */
  'fuck','fucker','fuk','fck','shit','bitch','slut','whore','cunt','dick',
  'pussy','asshole','bastard','nigger','nigga','porn','sex','xxx','nude',
  'nudes','rape','faggot','retard','idiot','stupid','moron'
];
/* تجميعها كـ Set من الجذور؛ المطابقة بالاحتواء بعد التطبيع */
const BAD_SET = BAD_ROOTS;

/**
 * يفحص نصاً. يرجّع {ok:true} أو {ok:false, reason, matched}
 */
export function checkText(raw) {
  const norm = normalize(raw);
  if (!norm) return { ok: true };
  for (const root of BAD_SET) {
    const r = normalize(root);
    if (r && norm.includes(r)) {
      return { ok: false, reason: 'يحتوي النص على ألفاظ غير لائقة.', matched: root };
    }
  }
  /* كشف سبام: رابط مكرر/أكثر من 5 روابط، أو حرف واحد مكرر بشكل مفرط */
  const links = (String(raw).match(/https?:\/\//gi) || []).length;
  if (links > 5) return { ok: false, reason: 'عدد الروابط كبير (سبام محتمل).' };
  if (/(.)\1{15,}/.test(String(raw))) return { ok: false, reason: 'نص متكرر (سبام محتمل).' };
  return { ok: true };
}

/* ───────────────────────────────────────────────
   2) كشف المحتوى المرئي المسيء (عُري/إباحية) — NSFWJS
   نموذج TensorFlow.js مجاني يعمل بالكامل في المتصفح، بلا خادم وبلا تكلفة.
   نحمّله كسلاً (lazy) من CDN عند أول استخدام فقط.
   الفئات: Drawing, Hentai, Neutral, Porn, Sexy
   ─────────────────────────────────────────────── */

let _nsfwModel = null;
let _nsfwLoading = null;

async function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('load fail: ' + src));
    document.head.appendChild(s);
  });
}

async function ensureNsfw() {
  if (_nsfwModel) return _nsfwModel;
  if (_nsfwLoading) return _nsfwLoading;
  _nsfwLoading = (async () => {
    await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/nsfwjs@4.2.1/dist/nsfwjs.min.js');
    /* nsfwjs ينشر كائناً عالمياً */
    /* eslint-disable no-undef */
    _nsfwModel = await nsfwjs.load();  /* يحمّل النموذج الافتراضي (mobilenet) */
    return _nsfwModel;
  })();
  return _nsfwLoading;
}

/* يحوّل ملفاً (صورة) إلى عنصر <img> جاهز للتحليل */
function fileToImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image decode fail')); };
    img.src = url;
  });
}

/**
 * يفحص ملف صورة. يرجّع {ok, reason, scores}.
 * فشل التحميل (شبكة) → ok:true مع flagged:false (لا نمنع المستخدم بسبب عطل شبكة؛
 *   الطبقة الثانية Vision على الخادم تبقى تحرس). مرّر strict:true لمنع عند الفشل.
 * العتبة: Porn+Hentai مجموعهما ≥ 0.55 أو Sexy ≥ 0.80 → حظر.
 */
export async function checkImage(file, opts = {}) {
  if (!file || !String(file.type || '').startsWith('image/')) return { ok: true };
  let model;
  try { model = await ensureNsfw(); }
  catch (e) {
    return opts.strict
      ? { ok: false, reason: 'تعذّر فحص الصورة. حاول لاحقاً.' }
      : { ok: true, degraded: true };
  }
  let ref;
  try {
    ref = await fileToImage(file);
    const preds = await model.classify(ref.img);
    const s = {};
    preds.forEach(p => { s[p.className] = p.probability; });
    const porn = (s.Porn || 0) + (s.Hentai || 0);
    const sexy = s.Sexy || 0;
    if (porn >= 0.55 || sexy >= 0.80) {
      return { ok: false, reason: 'الصورة تحتوي محتوى غير لائق وتم رفضها.', scores: s };
    }
    return { ok: true, scores: s };
  } catch (e) {
    return opts.strict ? { ok: false, reason: 'تعذّر فحص الصورة.' } : { ok: true, degraded: true };
  } finally {
    if (ref) URL.revokeObjectURL(ref.url);
  }
}

/* يفحص فريماً من فيديو (الإطار الأول) — للمقاطع القصيرة */
export async function checkVideoFrame(file, opts = {}) {
  if (!file || !String(file.type || '').startsWith('video/')) return { ok: true };
  let model;
  try { model = await ensureNsfw(); }
  catch (e) { return opts.strict ? { ok: false, reason: 'تعذّر فحص الفيديو.' } : { ok: true, degraded: true }; }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.src = url; v.crossOrigin = 'anonymous';
    let done = false;
    const finish = (r) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(r); };
    v.onloadeddata = () => { try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch (e) { finish({ ok: true }); } };
    v.onseeked = async () => {
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth || 224; c.height = v.videoHeight || 224;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const preds = await model.classify(c);
        const s = {}; preds.forEach(p => s[p.className] = p.probability);
        const porn = (s.Porn || 0) + (s.Hentai || 0), sexy = s.Sexy || 0;
        if (porn >= 0.55 || sexy >= 0.80) finish({ ok: false, reason: 'المقطع يحتوي محتوى غير لائق وتم رفضه.', scores: s });
        else finish({ ok: true, scores: s });
      } catch (e) { finish(opts.strict ? { ok: false, reason: 'تعذّر فحص الفيديو.' } : { ok: true, degraded: true }); }
    };
    v.onerror = () => finish(opts.strict ? { ok: false, reason: 'تعذّر فحص الفيديو.' } : { ok: true, degraded: true });
    setTimeout(() => finish({ ok: true, degraded: true }), 15000);  /* مهلة أمان */
  });
}

/* ───────────────────────────────────────────────
   3) حدّ المعدّل (Rate limit) ضد السبام/البوتات — client-side
   يخزّن طوابع العمليات في localStorage. ليس حماية مطلقة (يُتجاوز بمسح التخزين)
   لكنه يوقف السبام العادي والبوتات الساذجة. الحماية الصلبة = App Check + قواعد.
   ─────────────────────────────────────────────── */

/**
 * @param {string} key  مُعرّف العملية، مثل 'post', 'comment', 'upload'
 * @param {number} max  أقصى عدد عمليات ضمن النافذة
 * @param {number} windowMs  طول النافذة بالمللي ثانية
 * @returns {{ok:boolean, waitMs:number}}
 */
export function rateLimit(key, max, windowMs) {
  const k = 'esc_rl_' + key;
  const now = Date.now();
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { arr = []; }
  arr = arr.filter(t => now - t < windowMs);
  if (arr.length >= max) {
    const waitMs = windowMs - (now - arr[0]);
    return { ok: false, waitMs: Math.max(0, waitMs) };
  }
  arr.push(now);
  try { localStorage.setItem(k, JSON.stringify(arr)); } catch (e) {}
  return { ok: true, waitMs: 0 };
}

/* ───────────────────────────────────────────────
   4) Honeypot — فخّ البوتات
   نزرع حقلاً نصياً مخفياً (off-screen). المستخدم الحقيقي لا يراه ولا يملؤه؛
   البوت الآلي يملأ كل الحقول → نكشفه.
   ─────────────────────────────────────────────── */

export function honeypotTrap(container) {
  if (!container || container.querySelector('.esc-hp')) return;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'esc-hp'; inp.tabIndex = -1;
  inp.autocomplete = 'off'; inp.setAttribute('aria-hidden', 'true');
  inp.name = 'website'; /* اسم مغرٍ للبوت */
  inp.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  container.appendChild(inp);
}

export function isHoneypotFilled(container) {
  const inp = container && container.querySelector('.esc-hp');
  return !!(inp && inp.value);
}

/* أداة مساعدة موحّدة: تنسيق زمن الانتظار بالعربية */
export function fmtWait(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} ثانية`;
  return `${Math.ceil(s / 60)} دقيقة`;
}
